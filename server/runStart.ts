// Starts a plan run from what the page chose: the `run` command's real
// starter. The page sends only the choices (which server, which model, tools
// and thinking on or off); everything else is looked up here, so a run is
// built from what is saved, not from what a page happens to hold.
//
//  - The session comes from its session.json (the page saves before it runs).
//  - The connector comes from the server's list, which says whether a key is
//    set (`hasKey`) and never holds the key itself. The key stays in
//    settings.json, and the proxy adds it to each request the run makes, so
//    nothing in a run, its events or the saved session has one.
//  - The models and the tool context come from the server's own /api, the way
//    the page asks for them (see setApiOrigin in src/api.ts).
//
// Then it starts the runner (server/runners.ts), which runs src/agent's
// runPlan with src/runnerReply's makeReply unless a test passes fakes.

import { type Connector, type Model, type ToolContext, getConnectors, getToolContext, listModels } from "../src/api.ts";
import { attachedPaths, workingDirOf } from "../src/runnerReply.ts";
import type { RunnerEnv } from "../src/runnerTypes.ts";
import type { RunOptions } from "./commands.ts";
import { HttpError } from "./http.ts";
import { type RunnerDeps, isRunning, startRunner } from "./runners.ts";
import { readSession } from "./sessionFile.ts";

// Runs one request to the server's own /api. A failure is a plain sentence
// for the page, not a stack: the server being unreachable is the likely cause.
async function ask<T>(what: string, request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (e: any) {
    throw new HttpError(502, `The plan didn't start: ${what}. ${e?.message ?? e}`, { reason: "unreachable" });
  }
}

// What a run needs besides the session, from the page's choices.
export async function buildEnv(session: any, options: RunOptions): Promise<RunnerEnv> {
  const { connectors } = await ask("couldn't read the list of servers", getConnectors());
  // The list's own entries: `hasKey`, never the key.
  const connector: Connector | undefined = connectors.find((c) => c.id === options.connectorId);
  if (!connector) {
    throw new HttpError(409, "That server isn't in your list any more, so the plan didn't start. Pick a server and run it again.", {
      reason: "no connector",
    });
  }
  const attachments = Array.isArray(session.attachments) ? session.attachments : [];
  // Fixed for the session's first reply, so its system prompt never changes
  // (see makeReply); until then it is the working folder.
  const promptDir = session.promptDir === undefined ? workingDirOf(attachments) : session.promptDir;
  const models: Model[] = await ask(`couldn't ask ${connector.name} for its models`, listModels(connector.id));
  const toolContext: ToolContext = await ask("couldn't read the tools", getToolContext(attachedPaths(attachments), promptDir));
  return {
    connector,
    model: options.model,
    models,
    toolContext,
    toolsOn: options.toolsOn,
    thinkOn: options.thinkOn,
    freshSteps: options.freshSteps,
  };
}

// Starts the saved session's plan. Answers once the run has begun (the hub
// marks the session as running); the run goes on after that. Refused (409) if
// it is running already, there's nothing to run, or the server isn't in the
// list; 404 for a session with no file.
export async function startFromOptions(id: string, options: RunOptions, deps: RunnerDeps = {}): Promise<void> {
  if (isRunning(id)) throw new HttpError(409, "This plan is already running.", { reason: "already running" });
  const session = await readSession(id);
  if (!session) throw new HttpError(404, "No such session");
  const env = await buildEnv(session, options);
  await startRunner(id, env, deps);
}
