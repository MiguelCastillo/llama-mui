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
//            card calls it Pause, a chat reply Stop. With { aside: true } it
//            stops only the side question being answered (the plan goes on),
//            or is refused ("not running") if none is.
//   approve  { askId, allow, always? }   yes or no to an access or approval question;
//            always (changes, git or commands) also approves that kind for the
//            rest of the session (see autoApprove.ts)
//   autoapprove { kind, on }   turns one of those on or off
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
//            a plan) and, optionally, `replyTo` (the text of the response the
//            message replies to: saved on the message so the chat shows it,
//            cut at MAX_REPLY_QUOTE characters, never sent to the model).
//            The session must be saved first: the history is what is
//            saved, and `text` is the new message. The answer is { ok,
//            revision } once the reply has begun; it streams as events. While
//            a reply streams, another message is refused ("reply running").
//
//   ask      { text, connectorId, model, toolsOn, thinkOn }   a side question
//            while a plan runs: answered beside the plan, written into the
//            session as messages marked `aside`, and never shown to a step (see
//            aside.ts). It can only read. The answer is { ok, revision } once
//            the question has begun; the reply streams as events. With no plan
//            running it is refused ("not running": the page sends a normal
//            message); while another side question is answered, "aside running".
//
// An answer is { ok: true, revision }: the session's revision once the command
// is done (for `run`, also { sessionId }, and the revision is that session's). A command that can't be done is a 409 with a plain `error` and a
// `reason`: "already running" (a second window starting the same plan),
// "not running", "stale ask" (that question was answered already: the first
// answer wins), "nothing to run", "wrong answer", "no step left", "stale revision",
// "reply running", "aside running", "not a plan" (Pause for a single reply),
// "no connector" (the server the page chose isn't in the list any more). A run
// that can't reach the model server or its tools is a 502, reason "unreachable".

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import * as hub from "./runHub.ts";
import { startAsideFromOptions, startFromOptions, startTurnFromOptions } from "./runStart.ts";
import * as runners from "./runners.ts";
import { AUTO_KINDS, type AutoKind, withAuto } from "../src/autoApprove.ts";
import { sessionFolder } from "./sessionFile.ts";
import { validateRefs } from "./images.ts";
import { MAX_REPLY_QUOTE } from "../src/api.ts";

export interface RunOptions {
  connectorId: string;
  model: string;
  toolsOn: boolean;
  thinkOn: boolean;
  freshSteps?: boolean;
  // Image refs for a chat turn (validated refs to files in the session's images folder).
  images?: { id: string; mediaType: string }[];
}

export interface CommandDeps {
  // Starts the run of a saved session from what the page chose. Says which
  // session the plan runs in; nothing means the one it was sent to.
  start: (id: string, options: RunOptions) => Promise<{ sessionId: string } | void>;
  // Starts one chat reply for the saved session (a message to a session with
  // no run). Tests pass a fake.
  chat?: (id: string, text: string, options: RunOptions & { planning: boolean; replyTo?: string }) => Promise<void>;
  // Starts a side question in a session whose plan runs (see aside.ts); answers
  // once it has begun. Tests pass a fake.
  aside?: (id: string, text: string, options: RunOptions) => Promise<void>;
}

// The real starters build the run from the page's choices (see runStart.ts);
// tests pass their own to start a run from a fake.
const defaultDeps: Required<CommandDeps> = {
  start: (id, options) => startFromOptions(id, options),
  chat: (id, text, options) => startTurnFromOptions(id, text, options),
  aside: (id, text, options) => startAsideFromOptions(id, text, options),
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

const autoKindOf = (v: unknown): AutoKind => {
  if (typeof v === "string" && (AUTO_KINDS as readonly string[]).includes(v)) return v as AutoKind;
  throw new HttpError(400, `kind must be one of ${AUTO_KINDS.join(", ")}`);
};

// The response a message replies to: left out, or a string. Blank is the same
// as none, and one longer than MAX_REPLY_QUOTE is cut short with "…".
const replyToOf = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, "replyTo must be text");
  if (!v.trim()) return undefined;
  return v.length > MAX_REPLY_QUOTE ? `${v.slice(0, MAX_REPLY_QUOTE).trimEnd()}…` : v;
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
      if (body.aside === true) {
        // Only the side question; the plan goes on.
        if (!runners.abortAside(id)) {
          throw new HttpError(409, "No side question is being answered.", { reason: "not running" });
        }
        break;
      }
      await runners.stopRun(id);
      break;
    case "message": {
      const images = body.images;
      const text = body.text ?? "";
      if (typeof text !== "string") throw new HttpError(400, "text must be given");
      if (runners.isRunning(id)) {
        // A plan: folded in before the next step; the answer says which one.
        // Images are refused (a plan message has no images field).
        if (images) throw new HttpError(409, "Images can't be attached while a plan is running. Send the text without the image and try again.", {
          reason: "reply running",
        });
        if (!text.trim()) throw new HttpError(400, "text must be given");
        extra = await runners.sendNote(id, text);
      } else {
        // No run: one chat reply, run here.
        if (body.planning !== undefined && typeof body.planning !== "boolean") throw new HttpError(400, "planning must be true or false");
        // Validate image refs (empty list is fine — no images is fine too).
        const validated = images ? await validateRefs(id, images) : undefined;
        await deps.chat(id, text, { ...parseRunOptions(body), planning: body.planning === true, images: validated, replyTo: replyToOf(body.replyTo) });
      }
      break;
    }
    case "ask": {
      // A side question: answered beside the running plan, which never sees it.
      const text = body.text;
      if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text must be given");
      const options = parseRunOptions(body);
      // Only a plan has something to ask beside; with none, the page sends the
      // question as an ordinary message.
      if (!runners.isRunning(id) || hub.liveRun(id)?.kind === "turn") {
        throw new HttpError(409, "No plan is running in this session, so there is nothing to ask beside. Send it as a normal message.", {
          reason: "not running",
        });
      }
      await deps.aside(id, text, options);
      break;
    }
    case "approve":
      if (typeof body.allow !== "boolean") throw new HttpError(400, "allow must be true or false");
      // `always`: also approve this kind of thing for the rest of the session.
      // Set first, so the next question of that kind is already approved.
      if (body.allow && body.always !== undefined) {
        const kind = autoKindOf(body.always);
        await hub.edit(id, (s) => void (s.autoApprove = withAuto(s.autoApprove, kind, true)));
      }
      if (body.plan !== undefined && typeof body.plan !== "boolean") throw new HttpError(400, "plan must be true or false");
      // "Make plan" is a no that asks for a plan; it can't come with a yes.
      if (body.plan === true && body.allow) throw new HttpError(400, "plan can't go with allow: true");
      await runners.answerAsk(id, askIdOf(body), body.plan === true ? "plan" : body.allow);
      break;
    case "autoapprove": {
      // Turns an approval-for-the-session on or off, from the chip in the chat.
      const kind = autoKindOf(body.kind);
      if (typeof body.on !== "boolean") throw new HttpError(400, "on must be true or false");
      await hub.edit(id, (s) => void (s.autoApprove = withAuto(s.autoApprove, kind, body.on)));
      break;
    }
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
