// Starts a plan run from what the page chose: the `run` command's real
// starter. The page sends only the choices (which server, which model, tools
// and thinking on or off); everything else is looked up here, so a run is
// built from what is saved, not from what a page happens to hold.
//
//  - The session comes from its session.json (the page saves before it runs).
//    A plan that has not started is moved into a new thread first (the thread
//    is the session that runs); see startFromOptions.
//  - The connector comes from the server's list, which says whether a key is
//    set (`hasKey`) and never holds the key itself. The key stays in
//    settings.json, and the proxy adds it to each request the run makes, so
//    nothing in a run, its events or the saved session has one.
//  - The models and the tool context come from the server's own /api, the way
//    the page asks for them (see setApiOrigin in src/api.ts).
//
// Then it starts the runner (server/runners.ts), which runs src/agent's
// runPlan with src/runnerReply's makeReply unless a test passes fakes.

import { randomUUID } from "node:crypto";
import { type Connector, type Model, type Session, type ToolContext, getConnectors, getToolContext, listModels } from "../src/api.ts";
import { isFreshPlan, planToThread } from "../src/planThread.ts";
import { attachedPaths } from "../src/runnerReply.ts";
import type { RunnerEnv } from "../src/runnerTypes.ts";
import { chooseThread } from "./chooseThread.ts";
import type { RunOptions } from "./commands.ts";
import { HttpError } from "./http.ts";
import * as hub from "./runHub.ts";
import { type RunnerDeps, isRunning, startRunner, startTurn } from "./runners.ts";
import { deleteSession, readSession, revisionOf } from "./sessionFile.ts";

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
  // (see makeReply); until then it is the working directory.
  const workingDir: string | null = typeof session.workingDir === "string" ? session.workingDir : null;
  const promptDir = session.promptDir === undefined ? (session.workingDir ?? null) : session.promptDir;
  const models: Model[] = await ask(`couldn't ask ${connector.name} for its models`, listModels(connector.id));
  const toolContext: ToolContext = await ask(
    "couldn't read the tools",
    getToolContext(workingDir, attachedPaths(attachments), promptDir),
  );
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

export interface StartDeps extends RunnerDeps {
  // Ids for new threads; tests choose their own.
  newId?: () => string;
}

// A plan that has not started moves into a thread of its own, and runs there
// (the choice of thread is chooseThread's). The thread is saved first, then
// the session it came from, without the plan and with a note where it was;
// only then does the run start on the thread. Nothing is saved until the
// server and the tools have answered, so a refusal leaves no thread behind.
// If the session changed since it was read (a save from a page, or a second
// window starting the same plan), the thread is deleted again and nothing
// started. If the run itself can't begin after both are saved, the thread
// stays: it holds the plan, and Run there starts it in place.
async function startInThread(
  id: string,
  disk: any,
  moved: { parent: Session; child: Session },
  options: RunOptions,
  deps: StartDeps,
): Promise<string> {
  const childId = moved.child.id;
  const env = await buildEnv(moved.child, options);
  const now = Date.now();
  await hub.replace(childId, () => ({
    ...moved.child,
    title: moved.child.title.slice(0, 100),
    modelName: null,
    userName: null,
    createdAt: now,
    updatedAt: now,
  }));
  try {
    await hub.replace(id, () => ({ ...moved.parent, updatedAt: now }), revisionOf(disk));
  } catch (e) {
    await hub.remove(childId, () => deleteSession(childId)).catch(() => {});
    if (e instanceof HttpError && e.extra.reason === "stale revision") {
      throw new HttpError(409, "This session changed just now, so the plan wasn't started. Look at the session again and run it.", {
        reason: "stale revision",
      });
    }
    if (e instanceof HttpError && e.extra.reason === "run active") {
      throw new HttpError(409, "This plan is already running.", { reason: "already running" });
    }
    throw e;
  }
  await startRunner(childId, env, deps);
  return childId;
}

// Starts one chat reply for the saved session: the `message` command for a
// session with no run. The page saved the session first (the messages before
// this one, so Resend has cut the failed reply off); the model's history is
// that, plus `text`. Built from the same choices as a plan run, plus the
// planning switch. Answers once the run has begun; the reply streams after
// that. Refused (409) if a run began in the meantime; 404 for a session with
// no file.
export async function startTurnFromOptions(
  id: string,
  text: string,
  options: RunOptions & { planning: boolean },
  deps: RunnerDeps = {},
): Promise<void> {
  const disk = await readSession(id);
  if (!disk) throw new HttpError(404, "No such session");
  const env = await buildEnv(disk, options);
  await startTurn(id, env, { text, planning: options.planning, images: options.images }, deps);
}

// Starts the saved session's plan and says which session it runs in. Answers
// once the run has begun (the hub marks that session as running); the run goes
// on after that. A plan that has not started moves into a new thread and runs
// there (the answer is the thread's id); one that has started, or that was
// moved in already, runs where it is (the answer is `id`). Refused (409) if it
// is running already, there's nothing to run, or the server isn't in the list;
// 404 for a session with no file.
export async function startFromOptions(id: string, options: RunOptions, deps: StartDeps = {}): Promise<{ sessionId: string }> {
  if (isRunning(id)) throw new HttpError(409, "This plan is already running.", { reason: "already running" });
  const disk = await readSession(id);
  if (!disk) throw new HttpError(404, "No such session");

  const { revision: _revision, run: _run, ...saved } = disk;
  const session = { ...saved, attachments: Array.isArray(saved.attachments) ? saved.attachments : [] } as Session;
  if (!session.planMovedIn && session.plan && isFreshPlan(session.plan, session.messages ?? [])) {
    const choice = chooseThread(session, session.plan);
    switch (choice.kind) {
      case "new": {
        const moved = planToThread(session, (deps.newId ?? randomUUID)());
        if (moved) return { sessionId: await startInThread(id, disk, moved, options, deps) };
      }
    }
  }

  const env = await buildEnv(session, options);
  await startRunner(id, env, deps);
  return { sessionId: id };
}
