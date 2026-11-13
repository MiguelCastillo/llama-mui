// Plan runners, on the server: a plan runs here, not in a page, so it keeps
// going when the page is closed, reloaded or showing another session. This is
// the browser's old store of runners moved over, with the hub as its owner.
// A chat reply runs here too (startTurn): a message to a session with no plan
// running is one reply, run as a one-reply run, so every session has one owner
// whether it is being chatted with or running a plan. The run record says
// which (`kind`: "turn"). Below, "the run" means either.
//
//  - One entry per session with a run. The entry holds the live Session (the
//    hub reads it through `session`, so a rename during the run goes into it
//    and its next save doesn't undo that).
//  - Saving goes through the hub (hub.save, debounced here), so every write
//    bumps the revision and a page's own save is refused meanwhile.
//  - The run's state (status, the pending ask, whether a request is in flight,
//    the error) lives in the hub's run record, as plain data. The ask's resolver
//    stays here, in memory; a command carrying the ask's id resolves it. Events
//    reach pages through the hub: `status` and `ask` (hub.updateRun), `step` (a
//    step changed), `session` (patches of the session, hub.announce), `saved`.
//  - It runs src/agent's runPlan and src/runnerReply's makeReply, the same code
//    the page used to run, with no React. Those call the server's own /api over
//    http (see setApiOrigin in src/api.ts), so the proxy adds the API key and
//    nothing here ever holds one.
//
// Status is derived, in this order:
//   waiting  an ask is pending (approval, access, location)
//   running
// A message from the user to the run (sendNote) is folded in before the next
// step, never queued silently: it is acknowledged with the step that will see
// it, or refused.
// A side question (server/aside.ts, through openAside) is answered beside the
// plan, on its own request, and its messages are kept apart from the plan's own
// list (src/asides.ts) so a step's reply, which writes back the list it has,
// can't drop them. The plan never sees them.
// A message sent while a reply streams waits in the session's queue (the
// `message` command puts it there). When the reply ends normally the first
// queued message starts as a normal reply (see end); Stop or a failure pauses
// the queue instead, and a paused queue sends nothing until a command says so.
// When the run is over (for any reason) its entry is gone and the hub's run
// record with it: the session is the page's again, and the page learns how it
// ended from the `status` event (run null, and `error` if it went wrong).
// A run in a thread (a session with a parent that has a note for it) ends with
// a report to that parent: how it ended and a sentence or two (threadReport.ts).
//
// Each function that a command calls answers once the hub has the new state,
// and throws an HttpError (409, with a `reason`) for what can't be done.

import { randomUUID } from "node:crypto";
import { type RunPlanCallbacks, runPlan } from "../src/agent/agent.ts";
import type { ChatMessage, PlanStep, QueuedMessage, Session } from "../src/api.ts";
import { type AsideGroup, plainCount, splitAsides, weaveAsides, withoutAsides } from "../src/asides.ts";
import { planRequestFor } from "../src/planThread.ts";
import { attachedPaths, makeReply, modelLoaded } from "../src/runnerReply.ts";
import type { Answer, Ask, RunnerEnv, RunnerHandle } from "../src/runnerTypes.ts";
import { autoApproves } from "../src/autoApprove.ts";
import { HttpError } from "./http.ts";
import * as hub from "./runHub.ts";
import { readSession, revisionOf } from "./sessionFile.ts";
import { type AskReport, askModel, reportToParent } from "./threadReport.ts";
import { appendUsage } from "./usageLog.ts";

export interface RunnerDeps {
  // Runs the plan; runPlan unless a test passes a fake.
  run?: (callbacks: RunPlanCallbacks) => Promise<void>;
  // Saves the session (the debounced saves while it runs); hub.save unless a
  // test passes a fake. The final save is the hub's, when the run ends.
  save?: (session: Session) => Promise<unknown>;
  // Builds the function that runs one reply (see RunPlanCallbacks.reply);
  // makeReply in src/runnerReply.ts unless a test passes a fake.
  reply?: (handle: RunnerHandle) => RunPlanCallbacks["reply"];
  // Whether the model is loaded; modelLoaded in src/runnerReply.ts by default.
  modelLoaded?: (handle: RunnerHandle) => Promise<boolean>;
  // Asks the model for the report a thread sends its parent when its run ends
  // (see threadReport.ts); one request to the run's own model by default.
  report?: AskReport;
  // Starts a queued message as a normal chat reply once the reply before it has
  // ended (see end). runStart's startTurnFromOptions passes one; with none the
  // queue is only paused, never sent.
  next?: (id: string, item: QueuedMessage) => Promise<void>;
}

type ResolvedDeps = Required<Omit<RunnerDeps, "next">> & Pick<RunnerDeps, "next">;

// A save comes this long after the last change, and at the latest this long
// after the first change since the previous save.
export const SAVE_DELAY = 800;
export const SAVE_MAX_WAIT = 5000;

// How long Stop waits for the run to be over before it answers anyway.
export const STOP_WAIT_MS = 10_000;

interface Entry {
  id: string;
  // A plan, or one chat reply (see startTurn).
  kind: "plan" | "turn";
  session: Session;
  env: RunnerEnv;
  deps: ResolvedDeps;
  handle: RunnerHandle;
  // The pending ask: its id (what a command names), the ask itself, and the
  // way to resolve it. Only {id, kind, details} reaches the hub.
  ask: { id: string; ask: Ask; decide: (answer: Answer) => void } | null;
  error: string | null;
  // Messages from the user that no step has seen yet (see sendNote). They are
  // part of the run record, so a page that connects later shows them.
  notes: hub.RunNote[];
  // The side questions asked during a plan run, apart from the plan's own
  // messages (see src/asides.ts, and change below). Those already in the
  // session when the run began are here too.
  asides: AsideGroup[];
  // The side question being answered, if any (see openAside); one at a time.
  aside: { controller: AbortController; done: Promise<void> } | null;
  // The run is over and being wrapped up: no side question starts now.
  closing: boolean;
  controller: AbortController | null;
  stopRequested: boolean;
  // Aborted by a forced stop (Stop everything): it cuts short what a plain
  // Stop lets finish, such as a tool call that is running.
  kill: AbortController;
  ended: boolean;
  // Dropped by resetRunners (tests): nothing is reported for it.
  discarded: boolean;
  // The step in flight, and the one that was when Stop came.
  runningStep: string | null;
  stepAtStop: string | null;
  dirty: boolean;
  saving: Promise<void> | null;
  saveAgain: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  maxWait: ReturnType<typeof setTimeout> | null;
  // What the hub's run record says now (as JSON), and the queue of updates
  // on their way to it.
  pushed: string;
  chain: Promise<void>;
  // Settles once the run is over and the hub has let go of the session.
  done: Promise<void>;
}

const store = new Map<string, Entry>();

export const isRunning = (id: string) => store.has(id);

const notRunning = () => new HttpError(409, "No plan is running in this session.", { reason: "not running" });
const alreadyRunning = () => new HttpError(409, "This plan is already running.", { reason: "already running" });
const busy = () =>
  new HttpError(409, "This session is busy: a reply or a plan is already running in it. Your text is still in the box.", {
    reason: "already running",
  });

function liveEntry(id: string): Entry {
  const e = store.get(id);
  if (!e || e.ended) throw notRunning();
  return e;
}

function statusOf(e: Entry): hub.RunStatus {
  if (e.ask) return "waiting";
  return "running";
}

// The pending ask as plain data: what a page needs to show the question.
export function askToPlain(id: string, ask: Ask): hub.RunAsk {
  if ("needsAccess" in ask) return { id, kind: "access", details: ask.needsAccess };
  if ("needsLocation" in ask) return { id, kind: "location", details: ask.needsLocation };
  return { id, kind: "approval", details: ask.needsApproval };
}

// Brings the hub's run record up to date with the entry. Updates go one after
// another, each reading the entry as it is when its turn comes, so the last
// state always wins and an unchanged one is not sent again. Resolves when the
// record is current.
function sync(e: Entry): Promise<void> {
  e.chain = e.chain.then(async () => {
    if (e.ended) return;
    const next = {
      status: statusOf(e),
      ask: e.ask ? askToPlain(e.ask.id, e.ask.ask) : null,
      streaming: e.controller !== null,
      stopping: e.stopRequested,
      aside: e.aside !== null,
      error: e.error,
      notes: e.notes,
    };
    const key = JSON.stringify(next);
    if (key === e.pushed) return;
    e.pushed = key;
    try {
      await hub.updateRun(e.id, next);
    } catch (err) {
      console.warn(`Couldn't update the run of session ${e.id}: ${err}`);
    }
  });
  return e.chain;
}

// ── saving ───────────────────────────────────────────────────────────────────

function clearSaveTimers(e: Entry) {
  if (e.debounce) clearTimeout(e.debounce);
  if (e.maxWait) clearTimeout(e.maxWait);
  e.debounce = e.maxWait = null;
}

// Saves now if there is anything unsaved. One save at a time per session, so
// an older copy never lands after a newer one; a change that comes while one
// is in flight is saved when it finishes. Nothing is saved once the run is
// over: the hub's final save was the last write.
function persist(e: Entry) {
  clearSaveTimers(e);
  if (e.ended || !e.dirty) return;
  if (e.saving) {
    e.saveAgain = true;
    return;
  }
  e.dirty = false;
  e.saving = e.deps
    .save(e.session)
    .then(() => {})
    .catch((err) => {
      e.error = `Couldn't save the session: ${err?.message ?? err}`;
      sync(e);
    })
    .finally(() => {
      e.saving = null;
      if (e.saveAgain) {
        e.saveAgain = false;
        persist(e);
      }
    });
}

function scheduleSave(e: Entry) {
  if (e.ended) return;
  e.dirty = true;
  if (e.debounce) clearTimeout(e.debounce);
  e.debounce = setTimeout(() => persist(e), SAVE_DELAY);
  e.maxWait ??= setTimeout(() => persist(e), SAVE_MAX_WAIT);
}

// ── changing the session ─────────────────────────────────────────────────────

// Whoever calls it (the plan's replies write back the whole message list they
// have) can't lose a side question: when the messages changed, the side
// questions are woven back in.
function change(e: Entry, fn: (s: Session) => Session) {
  let next = fn(e.session);
  if (next === e.session) return;
  if (e.asides.length && next.messages !== e.session.messages) {
    next = { ...next, messages: weaveAsides(withoutAsides(next.messages), e.asides) };
  }
  e.session = next;
  scheduleSave(e);
  hub.announce(e.id);
}

// Changes one step, keeping its text and summary (unless the patch sets a
// summary); the patch replaces the rest, like Chat's setStep did. Pages hear
// of it as a `step` event.
function patchStep(e: Entry, id: string, patch: Omit<PlanStep, "id" | "text">) {
  if (!e.session.plan?.some((st) => st.id === id)) return;
  change(e, (s) => ({
    ...s,
    plan: s.plan!.map((st) =>
      st.id === id ? { id: st.id, text: st.text, ...(st.summary ? { summary: st.summary } : {}), ...patch } : st,
    ),
  }));
  hub.publish({
    type: "step",
    id: e.id,
    data: { step: id, status: patch.status, ...(patch.note ? { note: patch.note } : {}) },
  });
}

// ── asks ─────────────────────────────────────────────────────────────────────

// Stores the ask and resolves with the user's answer. An aborted request
// counts as deny. Asks wait for as long as it takes; nothing pops up.
function askUser(e: Entry, ask: Ask, signal: AbortSignal): Promise<Answer> {
  // Approved for the rest of the session (see autoApprove.ts): no question.
  if ("needsApproval" in ask && autoApproves(e.session.autoApprove, ask.needsApproval)) return Promise.resolve(true);
  return new Promise<Answer>((resolve) => {
    if (signal.aborted) return resolve(false);
    const decide = (answer: Answer) => {
      if (e.ask?.decide !== decide) return;
      signal.removeEventListener("abort", onAbort);
      e.ask = null;
      resolve(answer);
      sync(e);
    };
    const onAbort = () => decide(false);
    signal.addEventListener("abort", onAbort);
    e.ask = { id: randomUUID(), ask, decide };
    sync(e);
  });
}

// ── messages to the run ──────────────────────────────────────────────────────

// The step that starts next: after the one in flight, or the first open one if
// none is (a step just ended). The way runPlan picks: the first
// step that isn't done, and none at all if that one is disputed.
function nextStep(e: Entry): { id: string; number: number } | null {
  const plan = e.session.plan ?? [];
  const from = e.runningStep ? plan.findIndex((st) => st.id === e.runningStep) + 1 : 0;
  const i = plan.findIndex((st, j) => j >= from && st.status !== "done");
  if (i < 0 || plan[i].status === "disputed") return null;
  return { id: plan[i].id, number: i + 1 };
}

// Tells pages which step will see a note, or (step null) that none did.
function ack(e: Entry, note: hub.RunNote, seen: { step: number; stepId: string } | { step: null; reason: string }) {
  hub.publish({ type: "ack", id: e.id, data: { messageId: note.id, text: note.text, ...seen } });
}

// A message from the user to the running plan. It is folded in at the next step
// boundary, after the gate: the step that starts next gets it in its
// prompt (a step starts with a fresh context, so it would not see it
// otherwise), and so does every step after it. The answer, and an `ack` event,
// say which step that is, at once. Nothing is queued silently: with no step
// left to start (the last one is running, the plan is stopping) the message is
// refused (409, reason "no step left") and the page keeps the text. A message
// that was accepted but whose run ended before another step started is put in
// the chat marked as not seen (see end).
export async function sendNote(id: string, text: string): Promise<{ messageId: string; step: number; stepId: string }> {
  const e = liveEntry(id);
  const clean = text.trim();
  if (!clean) throw new HttpError(400, "text must be given");
  // A reply that is streaming takes no note: only a plan folds messages in.
  // (The `message` command puts a message sent during a reply in the session's
  // queue and doesn't come here; this stays as a guard.)
  if (e.kind === "turn") {
    throw new HttpError(
      409,
      "A reply is still streaming in this session. Wait for it to finish, or stop it, then send your message. Your text is still in the box.",
      { reason: "reply running" },
    );
  }
  const next = e.stopRequested ? null : nextStep(e);
  if (!next) {
    throw new HttpError(
      409,
      e.stopRequested
        ? "The plan is stopping, so no step is left to see this message. Your text is still in the box."
        : "No step is left to see this message: the last one is already running. Your text is still in the box; send it when the plan has finished.",
      { reason: "no step left" },
    );
  }
  const note: hub.RunNote = { id: randomUUID(), text: clean, step: next.number, stepId: next.id };
  e.notes = [...e.notes, note];
  ack(e, note, { step: next.number, stepId: next.id });
  await sync(e);
  return { messageId: note.id, step: next.number, stepId: next.id };
}

// What runPlan calls before each step (RunPlanCallbacks.userNotes): the waiting
// messages become user messages in the session, marked with the step that saw
// them, and runPlan puts them in its history and prompts. A note that meant to
// reach a different step than the one that starts (the plan changed) is
// acknowledged again with the right one.
function takeNotes(e: Entry, step: { id: string; number: number }): ChatMessage[] {
  if (!e.notes.length) return [];
  const taken = e.notes;
  e.notes = [];
  const messages: ChatMessage[] = taken.map((n) => ({ role: "user", content: n.text, seenByStep: step.number }));
  change(e, (s) => ({ ...s, messages: [...s.messages, ...messages] }));
  for (const n of taken) if (n.stepId !== step.id) ack(e, n, { step: step.number, stepId: step.id });
  sync(e);
  return messages;
}

// The run is over with messages no step saw: they go into the chat, marked as
// not seen, so the text is never lost, and pages are told.
function dropNotes(e: Entry) {
  if (!e.notes.length) return;
  const left = e.notes;
  e.notes = [];
  const reason = e.stopRequested
    ? "The plan was stopped before another step started, so no step saw this message."
    : "The plan ended before another step started, so no step saw this message.";
  const messages: ChatMessage[] = left.map((n) => ({ role: "user", content: n.text, notSeen: true }));
  change(e, (s) => ({ ...s, messages: [...s.messages, ...messages] }));
  for (const n of left) ack(e, n, { step: null, reason });
}

// ── side questions ───────────────────────────────────────────────────────────

// What aside.ts gets of a running plan to answer a side question on its own
// request, without touching the plan: the session as it is now, a way to write
// the question and answer into it, and the signal that Stop (and the end of the
// run) raise.
export interface AsideSlot {
  session: () => Session;
  // Replaces all the messages of this side question (each marked `aside`).
  // They go into the run's own session, through its change(), so the run's
  // saves carry them and its page events show them.
  setMessages: (messages: ChatMessage[]) => void;
  // Aborted by Stop, by abortAside, and when the run ends.
  controller: AbortController;
  // Tells the run when the answer is over (or has failed). The run does not end
  // before it: it aborts the question and waits for this.
  track: (done: Promise<void>) => void;
  release: () => void;
}

// Takes the one place for a side question in a session whose plan is running.
// Refused (409) if no plan runs here (a reply is not a plan), if the plan is
// stopping, or if a side question is being answered already.
export function openAside(id: string): AsideSlot {
  const e = liveEntry(id);
  if (e.kind !== "plan" || e.stopRequested || e.closing) throw notRunning();
  if (e.aside) {
    throw new HttpError(409, "A side question is still being answered. Wait for it, or stop it, then ask again. Your text is still in the box.", {
      reason: "aside running",
    });
  }
  const controller = new AbortController();
  const mine = { controller, done: Promise.resolve() };
  e.aside = mine;
  // Placed after the messages the plan has now; the plan's later ones follow it.
  const group: AsideGroup = { at: withoutAsides(e.session.messages).length, messages: [] };
  e.asides = [...e.asides, group];
  // Pages learn that one is being answered (the Stop that ends only it).
  void sync(e);
  return {
    session: () => e.session,
    setMessages: (messages) => {
      group.messages = messages;
      change(e, (s) => ({ ...s, messages: [...s.messages] }));
    },
    controller,
    track: (done) => void (mine.done = done),
    release: () => {
      if (e.aside !== mine) return;
      e.aside = null;
      void sync(e);
    },
  };
}

// Stops the side question being answered, and nothing else. False if none is.
export function abortAside(id: string): boolean {
  const e = store.get(id);
  if (!e || e.ended || !e.aside) return false;
  e.aside.controller.abort();
  return true;
}

// ── the run ──────────────────────────────────────────────────────────────────

// Starts the plan of a saved session (its open steps, in order) and answers
// once the hub has marked the session as running. `env` is what the run needs
// besides the session: the connector (without its key), the model, the tools.
// Refused (409) if the session already has a run, or has no open step.
// `done` settles when the run is over; `finished` after that, once a thread has
// told its parent how it went (see threadReport.ts), which can take a model
// request, so nothing but a test waits for it.
export function startRunner(
  id: string,
  env: RunnerEnv,
  deps: RunnerDeps = {},
): Promise<{ revision: number; done: Promise<void>; finished: Promise<void> }> {
  return launch(id, env, deps, null);
}

// One chat reply, run here: the message a page sends to a session with no plan
// running. The session's saved messages are the history (the page saves before
// it sends, so a Resend has already cut the failed reply off); `text` is the
// new message, and `planning` is the page's planning switch (the turn only
// writes a plan, see PLANNING_NOTE). It is a run like a plan's, with the same
// owner, status, asks, Stop and events, but one reply long: no steps, so no
// Pause (it only has Stop) and no messages to it (see sendNote), and nothing is reported to a
// parent. Refused (409) if the session has a run already.
export function startTurn(
  id: string,
  env: RunnerEnv,
  turn: { text: string; planning: boolean; images?: { id: string; mediaType: string }[]; replyTo?: string },
  deps: RunnerDeps = {},
): Promise<{ revision: number; done: Promise<void>; finished: Promise<void> }> {
  return launch(id, env, deps, turn);
}

async function launch(
  id: string,
  env: RunnerEnv,
  deps: RunnerDeps,
  turn: { text: string; planning: boolean; images?: { id: string; mediaType: string }[]; replyTo?: string } | null,
): Promise<{ revision: number; done: Promise<void>; finished: Promise<void> }> {
  if (store.has(id)) throw turn ? busy() : alreadyRunning();
  const disk = await readSession(id);
  if (!disk) throw new HttpError(404, "No such session");
  // The revision and the run record are the hub's, not part of the session.
  const { revision: _revision, run: _run, ...saved } = disk;
  const session = (turn ? { ...saved, messages: Array.isArray(saved.messages) ? saved.messages : [] } : { ...saved, planMovedIn: false }) as Session;
  if (!turn && !session.plan?.some((st) => st.status === "pending")) {
    throw new HttpError(409, "There's no step left to run in this plan.", { reason: "nothing to run" });
  }

  // A plan works with its own messages only: side questions already in the
  // session (from an earlier run) are kept apart, and woven back in as it writes.
  const split = turn || !Array.isArray(session.messages) ? null : splitAsides(session.messages);
  const groups = split?.groups ?? [];
  const plain = groups.length ? split!.plain : session.messages;

  const planRunning = { current: false };
  const resolved: ResolvedDeps & { readImage: typeof import("../server/images.ts").read } = {
    run: deps.run ?? runPlan,
    next: deps.next,
    save: deps.save ?? ((s) => hub.save(id, s)),
    reply: deps.reply ?? makeReply,
    modelLoaded: deps.modelLoaded ?? modelLoaded,
    report: deps.report ?? askModel,
    readImage: async (id: string, imgId: string) =>
      (await import("../server/images.ts")).read(id, imgId),
  };
  const e = {
    id,
    kind: turn ? "turn" : "plan",
    session,
    env,
    deps: resolved,
    ask: null,
    error: null,
    notes: [],
    asides: groups,
    aside: null,
    closing: false,
    controller: null,
    stopRequested: false,
    kill: new AbortController(),
    ended: false,
    discarded: false,
    runningStep: null,
    stepAtStop: null,
    dirty: false,
    saving: null,
    saveAgain: false,
    debounce: null,
    maxWait: null,
    pushed: JSON.stringify({ status: "running", ask: null, streaming: false, stopping: false, aside: false, error: null, notes: [] }),
    chain: Promise.resolve(),
  } as unknown as Entry;

  // The hub refuses a second run, or one whose copy of the session is already
  // out of date; either way nothing has started.
  await hub.beginRun(id, { session: () => e.session, expectRevision: revisionOf(disk), kind: e.kind });
  store.set(id, e);

  const planRef = {
    get current() {
      return e.session.plan;
    },
    set current(plan: PlanStep[] | null) {
      change(e, (s) => ({ ...s, plan }));
    },
  };
  e.handle = {
    sessionId: id,
    env,
    // The plan counts messages without the side questions, so does its start.
    getSession: () =>
      e.asides.length
        ? { ...e.session, contextStart: plainCount(e.session.messages, e.session.contextStart ?? 0) }
        : e.session,
    edit: (fn) => change(e, fn),
    setError: (err) => {
      if (e.error === err) return;
      e.error = err;
      sync(e);
    },
    setAbort: (c) => {
      e.controller = c;
      // Stop came while this request was being set up (the model check, say):
      // it ends as soon as it starts.
      if (c && e.stopRequested) c.abort();
      sync(e);
    },
    killSignal: e.kill.signal,
    askUser: (ask, signal) => askUser(e, ask, signal),
    planRunningRef: planRunning,
    planRef,
    readImage: resolved.readImage,
    recordUsage: (rec) => appendUsage({ ...rec }),
  };

  const reply = resolved.reply(e.handle);

  if (turn) {
    e.done = (async () => {
      if (e.stopRequested) return;
      // The reply streams into the session as it goes (makeReply's callbacks),
      // and says how it ended through the error and `failed`; nothing to keep.
      await reply(turn.text, e.session.messages, { planning: turn.planning, images: turn.images, replyTo: turn.replyTo });
    })()
      .catch((err) => {
        if (!e.stopRequested) e.handle.setError(String(err?.message ?? err));
      })
      .finally(() => end(e));
    return { revision: await hub.currentRevision(id), done: e.done, finished: e.done };
  }

  const callbacks: RunPlanCallbacks = {
    connector: env.connector,
    model: env.model,
    abort: null,
    planRunningRef: planRunning,
    // The status is derived from the run, so there is nothing to set.
    setPlanRunning: () => {},
    messages: plain,
    planRef,
    setStep: (stepId, patch) => {
      if (patch.status === "running") e.runningStep = stepId;
      else if (e.runningStep === stepId) e.runningStep = null;
      patchStep(e, stepId, patch);
    },
    // After Stop nothing more is sent.
    reply: async (text, before, opts) =>
      e.stopRequested ? { ok: false, messages: before } : reply(text, before, opts),
    request: planRequestFor(plain, session.planAnchor),
    context: session.planContext,
    freshSteps: env.freshSteps,
    setError: e.handle.setError,
    setAbort: e.handle.setAbort,
    modelLoaded: async () => !e.stopRequested && resolved.modelLoaded(e.handle),
    models: env.models,
    workingDir: session.workingDir ?? null,
    attachments: session.attachments,
    checkCommands: env.toolContext.checkCommands,
    attachedPaths,
    sessionId: id,
    modelOptions: env.modelOptions,
    toolDefinitions: env.toolContext.definitions,
    // Messages the user sent join the chat, and the next step's prompt.
    userNotes: (step) => takeNotes(e, step),
    // No step starts once the run was stopped (Pause on the card).
    gate: () => Promise.resolve(!e.stopRequested),
  };

  e.done = resolved
    .run(callbacks)
    .catch((err) => {
      if (!e.stopRequested) e.handle.setError(String(err?.message ?? err));
    })
    .finally(() => end(e));
  // After the run is over, a thread tells the session it came from how it
  // went. This is not part of `done`: Stop and the next Run don't wait for a
  // model's report.
  const finished = e.done.then(() =>
    e.discarded
      ? undefined
      : reportToParent({ id, session: e.session, env, error: e.error, stopped: e.stopRequested }, resolved.report),
  );
  return { revision: await hub.currentRevision(id), done: e.done, finished };
}

// The run is over, whatever the reason: the step Stop interrupted is put back
// to pending, and the hub takes the final session, saves it and lets go.
async function end(e: Entry) {
  if (e.ended) return;
  e.closing = true;
  const stopped = e.stepAtStop && e.session.plan?.find((st) => st.id === e.stepAtStop);
  if (stopped && (stopped.status === "pending" || stopped.status === "running")) {
    const keep = stopped.answer ? { answer: stopped.answer, asked: stopped.asked } : {};
    patchStep(e, stopped.id, { status: "pending", note: "Paused", ...keep });
  }
  dropNotes(e);
  // A side question still being answered is cut off here, keeping what it had
  // written: it goes into the session through this run, which is over next.
  if (e.aside) {
    e.aside.controller.abort();
    await e.aside.done.catch(() => {});
  }
  await e.chain; // the run record is current before it goes
  // From here to store.delete nothing waits, so a message that comes in to the
  // queue (see commands.ts) is either in it now or is sent as a normal reply.
  const next = e.kind === "turn" ? settleQueue(e) : null;
  e.ended = true;
  e.runningStep = null;
  e.controller = null;
  e.ask?.decide(false);
  clearSaveTimers(e);
  store.delete(e.id);
  try {
    await hub.endRun(e.id, { error: e.error });
  } catch (err) {
    console.warn(`Couldn't finish the run of session ${e.id}: ${err}`);
  }
  // Only once the session is the hub's again can the next reply start.
  if (next) await startQueued(e.id, next, e.deps.next);
}

// What a reply's end does to the session's queue, as part of its last save: a
// reply that ended normally hands back the first queued message (removed from
// the queue, to be sent), unless the queue is paused. One that was stopped or
// failed (an error, or a reply that was cut off), or that has nothing to start
// the next with, pauses a queue that has something in it instead. Nothing
// happens to an empty queue. Called once per run (end runs once), so at most one
// message starts per ended reply.
function settleQueue(e: Entry): QueuedMessage | null {
  const goOn = !e.stopRequested && !e.error && !e.session.failed && !!e.deps.next;
  let next = null as QueuedMessage | null;
  change(e, (s) => {
    const queue = s.queue ?? [];
    if (!queue.length) return s;
    if (s.queuePaused) return s;
    if (!goOn) return { ...s, queuePaused: true };
    next = queue[0];
    return { ...s, queue: queue.slice(1) };
  });
  return next;
}

// Starts a queued message that settleQueue took out, as a normal reply. If it
// can't start, the message goes back to the front of the queue, so nothing the
// user typed is lost, and the queue is paused with the reason shown as the
// chat's error. The exception is a reply that began meanwhile (the user sent a
// message in the gap): the queue is left as it is, and that reply's end sends it.
async function startQueued(id: string, item: QueuedMessage, start: RunnerDeps["next"]) {
  try {
    if (!start) throw new Error("Nothing is set up to send it.");
    await start(id, item);
  } catch (err: any) {
    const meanwhile = err instanceof HttpError && err.extra.reason === "already running";
    try {
      await hub.edit(id, (s) => {
        const queue: QueuedMessage[] = Array.isArray(s.queue) ? s.queue : [];
        if (!queue.some((m) => m.id === item.id)) s.queue = [item, ...queue];
        if (!meanwhile) s.queuePaused = true;
      });
    } catch (editErr) {
      console.warn(`Couldn't put a queued message back in session ${id}: ${editErr}`);
    }
    if (!meanwhile) {
      hub.publish({
        type: "status",
        id,
        data: { run: null, error: `The next queued message wasn't sent, and the queue is paused. ${err?.message ?? err}` },
      });
    }
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

// Stop (the card's Pause, and a reply's Stop): the model's request is aborted
// and a pending ask is turned down, but a tool call that is running is let
// finish, so what it did is recorded; the run ends after it. Forced (Stop
// everything, held down on the page) that tool call is cut short too: the
// server stops what it started, such as a command (see /api/tools/call). A
// forced stop can follow a plain one that is still waiting. The run is over
// once runPlan returns; the step in flight goes back to pending, with the note
// "Paused", and the plan stays for `run` to pick up. Answers when the run is
// over, or after STOP_WAIT_MS if it still isn't (it goes on stopping).
export async function stopRun(id: string, opts: { force?: boolean } = {}) {
  const e = liveEntry(id);
  if (!e.stopRequested) {
    e.stopRequested = true;
    e.stepAtStop = e.runningStep;
    e.controller?.abort();
    e.aside?.controller.abort();
    e.ask?.decide(false);
    sync(e);
  }
  if (opts.force) e.kill.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([e.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS)))]);
  clearTimeout(timer);
}

// The user's answer to the pending ask, named by its id. The first answer
// wins: one for an ask that was answered already (or isn't pending any more)
// is refused (409, reason "stale ask") and changes nothing. A location ask
// takes the picked paths, or false for none; the others take true or false.
export async function answerAsk(id: string, askId: string, answer: Answer) {
  const e = liveEntry(id);
  if (!e.ask || e.ask.id !== askId) {
    throw new HttpError(409, "That question was already answered, or the plan isn't waiting on it any more.", {
      reason: "stale ask",
    });
  }
  const location = "needsLocation" in e.ask.ask;
  if (location && answer === true) {
    throw new HttpError(409, "That question asks for a file or folder. Pick one, or say no.", { reason: "wrong answer" });
  }
  // "plan" is never refused, whatever the question is: the work goes into a plan.
  if (answer !== "plan" && !location && typeof answer !== "boolean") {
    throw new HttpError(409, "That question is a yes or no. A picked file or folder doesn't answer it.", {
      reason: "wrong answer",
    });
  }
  e.ask.decide(answer);
  await e.chain;
}

// Stops every run in this process and waits until each is over. For a server
// that is closing in a process that goes on (the dev server restarting after a
// config change): its runs end properly, with their last save, instead of being
// left running with no server to hold them.
export async function stopAllRuns() {
  await Promise.all([...store.keys()].map((id) => stopRun(id, { force: true }).catch(() => {})));
}

// For tests: drops every entry without saving, and lets the hub go of the sessions.
export async function resetRunners() {
  const entries = [...store.values()];
  store.clear();
  for (const e of entries) {
    e.stopRequested = true;
    e.ended = true;
    e.discarded = true;
    clearSaveTimers(e);
    e.controller?.abort();
    e.aside?.controller.abort();
    e.ask?.decide(false);
    await hub.endRun(e.id).catch(() => {});
  }
}
