// Commands: what a page asks of a session's run. Events (events.ts) carry the
// run to the page; these are the way back, ordinary requests.
//
//   POST /api/sessions/<id>/commands/<name>     body: JSON
//
//   run      { connectorId, model, toolsOn, thinkOn, freshSteps? }  start the
//            plan's open steps. The session must be saved first: the run reads
//            it from the server, not from the page, and looks up the server
//            (connector), its models and the tools itself (see runStart.ts).
//            A plan that hasn't started moves into a new thread and runs
//            there; the answer says which session it runs in (`sessionId`)
//            and the page opens it.
//   stop     end the run now; answers once it is over. The plan stays, the
//            step in flight goes back to pending, and `run` picks it up. A plan
//            card calls it Pause, a chat reply Stop.
//   approve  { askId, allow }   yes or no to an access or approval question
//            (a no also turns down a question that asks for a path)
//   answer   { askId, paths: [{ path, kind, asWorkingDir? }] }   the files or
//            folders picked for a question that asks for a path; asWorkingDir
//            (a folder, in a chat with no working directory) sets it as the
//            working directory instead of attaching it
//   message  { text }   a message to the session.
//            While a plan runs, it is folded in before the next step (after
//            Pause's hold), which gets it in its prompt; the answer says
//            which step: { ok, revision, messageId, step, stepId }, and an
//            `ack` event says it too. Never queued silently: with no step
//            left to start it is refused ("no step left").
//            With no run, it is a chat turn, run here: the body also carries
//            the run's choices ({ connectorId, model, toolsOn, thinkOn }, as
//            for `run`) and `planning` (true when the reply should only write
//            a plan). The session must be saved first: the history is what is
//            saved, and `text` is the new message. The answer is { ok,
//            revision } once the reply has begun; it streams as events. While
//            a reply streams, another message is refused ("reply running").
//
// An answer is { ok: true, revision }: the session's revision once the command
// is done (for `run`, also { sessionId }, and the revision is that session's). A command that can't be done is a 409 with a plain `error` and a
// `reason`: "already running" (a second window starting the same plan),
// "not running", "stale ask" (that question was answered already: the first
// answer wins), "nothing to run", "wrong answer", "no step left", "stale revision",
// "reply running", "not a plan" (Pause for a single reply),
// "no connector" (the server the page chose isn't in the list any more). A run
// that can't reach the model server or its tools is a 502, reason "unreachable".

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import * as hub from "./runHub.ts";
import { startFromOptions, startTurnFromOptions } from "./runStart.ts";
import * as runners from "./runners.ts";
import { sessionFolder } from "./sessionFile.ts";

export interface RunOptions {
  connectorId: string;
  model: string;
  toolsOn: boolean;
  thinkOn: boolean;
  freshSteps?: boolean;
}

export interface CommandDeps {
  // Starts the run of a saved session from what the page chose. Says which
  // session the plan runs in; nothing means the one it was sent to.
  start: (id: string, options: RunOptions) => Promise<{ sessionId: string } | void>;
  // Starts one chat reply for the saved session (a message to a session with
  // no run). Tests pass a fake.
  chat?: (id: string, text: string, options: RunOptions & { planning: boolean }) => Promise<void>;
}

// The real starters build the run from the page's choices (see runStart.ts);
// tests pass their own to start a run from a fake.
const defaultDeps: Required<CommandDeps> = {
  start: (id, options) => startFromOptions(id, options),
  chat: (id, text, options) => startTurnFromOptions(id, text, options),
};

function parseRunOptions(body: any): RunOptions {
  const text = (v: unknown, name: string) => {
    if (typeof v !== "string" || !v) throw new HttpError(400, `${name} must be given`);
    return v;
  };
  const flag = (v: unknown, name: string) => {
    if (typeof v !== "boolean") throw new HttpError(400, `${name} must be true or false`);
    return v;
  };
  const freshSteps = body.freshSteps;
  if (freshSteps !== undefined && typeof freshSteps !== "boolean") throw new HttpError(400, "freshSteps must be true or false");
  return {
    connectorId: text(body.connectorId, "connectorId"),
    model: text(body.model, "model"),
    toolsOn: flag(body.toolsOn, "toolsOn"),
    thinkOn: flag(body.thinkOn, "thinkOn"),
    ...(freshSteps === undefined ? {} : { freshSteps }),
  };
}

const askIdOf = (body: any): string => {
  if (typeof body.askId !== "string" || !body.askId) throw new HttpError(400, "askId must be given");
  return body.askId;
};

// Handles POST /api/sessions/<id>/commands/<name>; returns false for anything else.
export async function commandRoutes({ req, res, parts, method }: Route, given: CommandDeps = defaultDeps): Promise<boolean> {
  const deps = { ...defaultDeps, ...given };
  if (parts.length !== 4 || parts[0] !== "sessions" || parts[2] !== "commands") return false;
  if (method !== "POST") throw new HttpError(405, "Commands are sent with POST");
  const id = parts[1];
  sessionFolder(id); // a bad id is a 400
  const body = await readJson(req);
  // The session the command ended up acting on: the one it was sent to, except
  // for a `run` that moved a new plan into a thread.
  let target = id;
  let extra: Record<string, unknown> = {};

  switch (parts[3]) {
    case "run": {
      const started = await deps.start(id, parseRunOptions(body));
      target = started?.sessionId ?? id;
      extra = { sessionId: target };
      break;
    }
    case "stop":
      await runners.stopRun(id);
      break;
    case "message": {
      if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text must be given");
      if (runners.isRunning(id)) {
        // A plan: folded in before the next step; the answer says which one.
        // (A reply that is streaming refuses it, see sendNote.)
        extra = await runners.sendNote(id, body.text);
      } else {
        // No run: one chat reply, run here.
        if (body.planning !== undefined && typeof body.planning !== "boolean") throw new HttpError(400, "planning must be true or false");
        await deps.chat(id, body.text, { ...parseRunOptions(body), planning: body.planning === true });
      }
      break;
    }
    case "approve":
      if (typeof body.allow !== "boolean") throw new HttpError(400, "allow must be true or false");
      await runners.answerAsk(id, askIdOf(body), body.allow);
      break;
    case "answer": {
      if (body.text !== undefined) {
        throw new HttpError(409, "Nothing is waiting for typed text. A step that asked a question is answered on the plan card, and the plan is run again.", {
          reason: "wrong answer",
        });
      }
      const paths = body.paths;
      const valid =
        Array.isArray(paths) &&
        paths.length > 0 &&
        paths.every((p) => typeof p?.path === "string" && p.path && (p.kind === "file" || p.kind === "folder"));
      if (!valid) throw new HttpError(400, "paths must be a list of { path, kind }, with kind file or folder");
      await runners.answerAsk(
        id,
        askIdOf(body),
        paths.map((p: any) => ({ path: p.path, kind: p.kind, ...(p.asWorkingDir === true && p.kind === "folder" && { asWorkingDir: true }) })),
      );
      break;
    }
    default:
      throw new HttpError(404, "Unknown command");
  }
  sendJson(res, 200, { ok: true, revision: await hub.currentRevision(target), ...extra });
  return true;
}
