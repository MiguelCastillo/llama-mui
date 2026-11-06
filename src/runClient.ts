// The page's side of a plan's run. The run is on the server (server/runners.ts);
// this module is a view of it: it listens to the server's events, keeps one view
// per session with a run, and sends the user's commands (run, pause, resume,
// stop, approve, answer, message) as ordinary requests. No React in this file.
//
// Two streams, both opened by the browser's EventSource, which opens them again
// by itself if the connection drops (every open starts with a `snapshot` that
// replaces what was known, so nothing missed meanwhile matters):
//
//  - GET /api/events, for the whole app: which sessions have a run, and when one
//    starts, changes status, asks something or ends. It is opened with the first
//    listener and stays open.
//  - GET /api/sessions/<id>/events, only for a session a listener has open and
//    that has a run: the run's live session (a snapshot, then patches, see
//    server/sessionPatch.ts) and its status. It closes when the last listener
//    goes or the run ends.
//
// When a run ends, the page reads the session once more from the server
// (getSession, which also brings the revision up to date: the page's next save
// carries it) and hands that to the listeners as a final view, status
// "stopped". A view of a run nobody was listening to is kept, if it needs the
// user (a step asked a question), until the session is opened (dismiss).
//
// Nothing here can hold an API key: the server never sends one, and the page
// never had one.

import { ApiError, type AutoKind, type Picked, type Session, getSession, sendCommand } from "./api";
import { applyPatch, type SessionPatch } from "../server/sessionPatch";
import type { Answer, Ask } from "./runnerTypes";
import { type RunnerView, needsYou } from "./runView";

export { isLive, needsYou, type RunnerStatus, type RunnerView } from "./runView";

// What a run needs from the page to start: the choices on screen. The server
// looks up the connector (and its key, which the page never sees), the models
// and the tools itself. The same as RunOptions in server/commands.ts.
export interface RunOptions {
  connectorId: string;
  model: string;
  toolsOn: boolean;
  thinkOn: boolean;
  // Settings → Tools, "Fresh context for each plan step"; on unless false.
  freshSteps?: boolean;
}

// The kinds of event subscribeAll gets: never one per streamed piece.
export type RunnerEventKind = "status" | "ask" | "dismissed";
export interface RunnerEvent {
  id: string;
  kind: RunnerEventKind;
  // Null once dismissed.
  view: RunnerView | null;
}

// The server's run record (RunState in server/runHub.ts), as it arrives.
interface WireRun {
  status: Exclude<RunnerView["status"], "stopped">;
  startedAt: number;
  // Missing: a plan.
  kind?: "turn";
  ask?: { id: string; kind: "access" | "location" | "approval"; details: any };
  streaming?: boolean;
  error?: string;
  notes?: { id: string; text: string; step: number; stepId: string }[];
}

interface Live {
  id: string;
  run: WireRun;
  // The run's session while a listener has it open; null otherwise.
  session: Session | null;
  // A command the server refused or couldn't be sent, until the next event.
  commandError: string | null;
  source: EventSource | null;
  ask: { id: string; value: NonNullable<RunnerView["ask"]> } | null;
  view: RunnerView;
}

// How long startRun waits to hear that the run began, and stop that it is over.
// The server's own wait for a stop is 10 seconds.
export const START_WAIT_MS = 3000;
export const STOP_WAIT_MS = 12_000;

const lives = new Map<string, Live>();
// Runs that ended unseen and need the user, until their session is opened.
const stopped = new Map<string, RunnerView>();
const listeners = new Map<string, Set<(view: RunnerView) => void>>();
const allListeners = new Set<(event: RunnerEvent) => void>();
// The reading of a session whose run just ended.
const ending = new Map<string, Promise<void>>();
// Goes up whenever a run starts or ends, so a command can tell it happened.
const generation = new Map<string, number>();
const waiters = new Set<() => void>();
let globalSource: EventSource | null = null;

const bump = (id: string) => generation.set(id, (generation.get(id) ?? 0) + 1);
const changed = () => {
  for (const w of [...waiters]) w();
};

// Resolves when `cond` holds, or after `ms`, whichever is first.
function waitUntil(cond: () => boolean, ms: number): Promise<void> {
  if (cond()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const check = () => cond() && done();
    const timer = setTimeout(() => done(), ms);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
  });
}

// ── views ────────────────────────────────────────────────────────────────────

const toAsk = (a: NonNullable<WireRun["ask"]>): Ask =>
  a.kind === "access" ? { needsAccess: a.details } : a.kind === "location" ? { needsLocation: a.details } : { needsApproval: a.details };

// The view's ask, the same object for as long as it is the same ask.
function askOf(l: Live): RunnerView["ask"] {
  const a = l.run.ask;
  if (!a) {
    l.ask = null;
    return null;
  }
  if (l.ask?.id !== a.id) {
    l.ask = { id: a.id, value: { ask: toAsk(a), decide: (answer) => void decide(l.id, a.id, answer), always: (kind) => void decide(l.id, a.id, true, kind) } };
  }
  return l.ask.value;
}

function viewOf(l: Live): RunnerView {
  return {
    sessionId: l.id,
    kind: l.run.kind ?? "plan",
    session: l.session,
    status: l.run.status,
    ask: askOf(l),
    error: l.commandError ?? l.run.error ?? null,
    streaming: !!l.run.streaming,
    startedAt: l.run.startedAt,
    notes: (l.run.notes ?? []).map(({ id, text, step }) => ({ id, text, step })),
  };
}

const notifyAll = (event: RunnerEvent) => {
  for (const fn of [...allListeners]) fn(event);
};

// Builds a new view and tells the listeners. subscribeAll hears of a change in
// the ask or the status (an ask first); plain changes (a streamed piece of the
// session) only reach the session's own listeners.
function touch(l: Live) {
  const before = l.view;
  const view = viewOf(l);
  l.view = view;
  for (const fn of [...(listeners.get(l.id) ?? [])]) fn(view);
  const kind: RunnerEventKind | null = view.ask !== before.ask ? "ask" : view.status !== before.status ? "status" : null;
  if (kind) notifyAll({ id: l.id, kind, view });
}

// ── events ───────────────────────────────────────────────────────────────────

function listen(source: EventSource, type: string, fn: (data: any) => void) {
  source.addEventListener(type, (e) => {
    let data: any;
    try {
      data = JSON.parse((e as MessageEvent).data);
    } catch {
      return;
    }
    fn(data);
  });
}

// A run exists (new, or changed).
function ensureLive(id: string, run: WireRun) {
  const known = lives.get(id);
  if (known) {
    known.run = run;
    known.commandError = null;
    touch(known);
    return;
  }
  stopped.delete(id);
  const l = { id, run, session: null, commandError: null, source: null, ask: null } as unknown as Live;
  lives.set(id, l);
  bump(id);
  l.view = viewOf(l);
  for (const fn of [...(listeners.get(id) ?? [])]) fn(l.view);
  notifyAll({ id, kind: "status", view: l.view });
  syncWatch(id);
  changed();
}

// Takes the session's final state from the server and hands it over as the
// last view of the run. `error` is how it ended, if badly.
function endRun(id: string, error?: string | null): Promise<void> {
  const l = lives.get(id);
  if (!l) return ending.get(id) ?? Promise.resolve();
  lives.delete(id);
  bump(id);
  l.source?.close();
  l.source = null;
  const last = l.session;
  const task = (async () => {
    let session: Session | null = last;
    try {
      session = await getSession(id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return dropped(id);
    }
    // Another run began meanwhile: its views are the current ones.
    if (lives.has(id)) return;
    const view: RunnerView = {
      sessionId: id,
      kind: l.run.kind ?? "plan",
      session,
      status: "stopped",
      ask: null,
      error: error ?? null,
      streaming: false,
      startedAt: l.run.startedAt,
      notes: [],
    };
    const heard = [...(listeners.get(id) ?? [])];
    for (const fn of heard) fn(view);
    if (!heard.length && needsYou(view)) stopped.set(id, view);
    notifyAll({ id, kind: "status", view });
  })();
  ending.set(id, task);
  void task.finally(() => {
    if (ending.get(id) === task) ending.delete(id);
    changed();
  });
  changed();
  return task;
}

// The session is gone (deleted): nothing of it is kept.
function dropped(id: string) {
  const l = lives.get(id);
  if (l) {
    lives.delete(id);
    bump(id);
    l.source?.close();
  }
  stopped.delete(id);
  notifyAll({ id, kind: "dismissed", view: null });
  changed();
}

const onStatus = (id: string, data: { run: WireRun | null; error?: string }) =>
  data.run ? ensureLive(id, data.run) : void endRun(id, data.error);

// The stream for the whole app.
function connect() {
  if (globalSource || typeof EventSource === "undefined") return;
  const source = new EventSource("/api/events");
  globalSource = source;
  listen(source, "snapshot", (data: { runs: { id: string; run: WireRun }[] }) => {
    const ids = new Set(data.runs.map((r) => r.id));
    for (const id of [...lives.keys()]) if (!ids.has(id)) void endRun(id);
    for (const r of data.runs) ensureLive(r.id, r.run);
  });
  listen(source, "status", (data) => onStatus(data.id, data));
  listen(source, "removed", (data) => dropped(data.id));
}

// Opens or closes the stream for one session's run: only while a listener has
// the session open and it has a run.
function syncWatch(id: string) {
  const l = lives.get(id);
  if (!l) return;
  const wanted = (listeners.get(id)?.size ?? 0) > 0;
  if (wanted && !l.source && typeof EventSource !== "undefined") {
    const source = new EventSource(`/api/sessions/${id}/events`);
    l.source = source;
    const current = () => lives.get(id) === l;
    listen(source, "snapshot", (data: { session: Session; run: WireRun | null }) => {
      if (!current()) return;
      l.session = data.session;
      if (!data.run) void endRun(id);
      else {
        l.run = data.run;
        l.commandError = null;
        touch(l);
      }
    });
    listen(source, "session", (data: { patch: SessionPatch }) => {
      if (!current() || !l.session) return;
      l.session = applyPatch(l.session, data.patch);
      touch(l);
    });
    listen(source, "status", (data) => current() && onStatus(id, data));
    listen(source, "removed", () => dropped(id));
  } else if (!wanted && l.source) {
    l.source.close();
    l.source = null;
    // What it had is no longer kept current.
    l.session = null;
  }
}

// ── the API ──────────────────────────────────────────────────────────────────

// The view of this session's run: live while it runs, or the last one of a run
// that ended and still needs the user.
export const getView = (id: string): RunnerView | undefined => lives.get(id)?.view ?? stopped.get(id);

// Every known run's view, for the "needs you" dots.
export const allViews = (): RunnerView[] => [...[...lives.values()].map((l) => l.view), ...stopped.values()];

// Calls fn with the view after every change to this session's run, including
// each streamed piece, and with the final view (status "stopped") when it ends.
// Returns the way to stop listening. It keeps listening across runs.
export function subscribe(id: string, fn: (view: RunnerView) => void): () => void {
  connect();
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(fn);
  syncWatch(id);
  return () => {
    set.delete(fn);
    if (!set.size && listeners.get(id) === set) listeners.delete(id);
    syncWatch(id);
  };
}

// Calls fn when any run's status or ask changes, when one ends, and when one
// is dismissed: never per streamed piece.
export function subscribeAll(fn: (event: RunnerEvent) => void): () => void {
  connect();
  allListeners.add(fn);
  return () => allListeners.delete(fn);
}

// Forgets the kept view of a run that ended unseen (its session was opened).
export function dismiss(id: string) {
  if (stopped.delete(id)) notifyAll({ id, kind: "dismissed", view: null });
}

// A command that can't be done because there is no run (it ended a moment ago)
// is not worth a message: the view already says so.
const quiet = (p: Promise<unknown>) =>
  p.then(
    () => {},
    (e) => {
      if (!(e instanceof ApiError && e.data.reason === "not running")) throw e;
    },
  );

// Starts the plan of a saved session. Save the session first: the server runs
// what is on disk. Throws an ApiError, a plain refusal ("already running" when
// a second window started it first). Answers with the session the plan runs
// in, once its run shows, so a guard that asks "is it running?" afterwards
// finds it so. That is `id`, except for a plan that hadn't started: the
// server moves it into a new thread and the answer is the thread's id.
export async function startRun(id: string, options: RunOptions): Promise<string> {
  const before = generation.get(id) ?? 0;
  const { sessionId = id } = await sendCommand(id, "run", { ...options });
  // A thread is new, so no run of it has been seen before.
  const seen = sessionId === id ? before : 0;
  await waitUntil(() => (generation.get(sessionId) ?? 0) !== seen, START_WAIT_MS);
  return sessionId;
}

// Stop is immediate: the plan card's Pause, and a reply's Stop. The plan stays.
// Answers once the run is over and its final session is in hand (see
// subscribe), so what the page does next starts from that.
export async function stop(id: string): Promise<void> {
  await quiet(sendCommand(id, "stop"));
  await waitUntil(() => !lives.has(id) && !ending.has(id), STOP_WAIT_MS);
}

// A message for the running plan. The server folds it in before the next step
// and answers with which step that is (the run's view lists it as a note until
// then); with no step left it refuses, an ApiError with the reason in plain
// words, and the caller keeps the text where the user typed it.
export async function sendMessage(id: string, text: string): Promise<{ step: number; messageId: string }> {
  const r = await sendCommand(id, "message", { text });
  return { step: r.step!, messageId: r.messageId! };
}

// A message to a session with no run: the server runs one chat reply (a turn)
// and streams it as events, so the view shows kind "turn" until it ends. The
// session must be saved first, as for a plan: the history is what is saved
// (Resend saves it cut short), and `text` is the new message. `planning`: the
// reply only writes a plan. Throws an ApiError (a plain refusal: a reply is
// already streaming, the server isn't in the list any more); the caller keeps
// the text where the user typed it. Answers once the run shows.
export async function sendChat(id: string, text: string, options: RunOptions & { planning: boolean }): Promise<void> {
  const before = generation.get(id) ?? 0;
  await sendCommand(id, "message", { text, ...options });
  await waitUntil(() => (generation.get(id) ?? 0) !== before, START_WAIT_MS);
}

// Yes or no to an access or approval question (a no also turns down a
// question that asks for a path).
export const approve = (id: string, askId: string, allow: boolean, always?: AutoKind) =>
  sendCommand(id, "approve", { askId, allow, ...(always ? { always } : {}) });

// Turns an approval for the rest of the session on or off (the chip in the chat).
export const setAutoApprove = (id: string, kind: AutoKind, on: boolean) => sendCommand(id, "autoapprove", { kind, on });

// The files or folders picked for a question that asks for a path.
export const answer = (id: string, askId: string, paths: Picked[]) => sendCommand(id, "answer", { askId, paths });

// The answer behind a view's `ask.decide`: a refusal shows as the run's error
// until the next event, except for a question that was answered already (the
// first answer wins; the events show what happened).
async function decide(id: string, askId: string, answerGiven: Answer, always?: AutoKind) {
  try {
    if (typeof answerGiven === "boolean") await approve(id, askId, answerGiven, always);
    else await answer(id, askId, answerGiven);
  } catch (e) {
    if (e instanceof ApiError && e.data.reason === "stale ask") return;
    const l = lives.get(id);
    if (!l) return;
    l.commandError = e instanceof Error ? e.message : String(e);
    touch(l);
  }
}

// For tests: closes every stream and forgets everything.
export function resetRunClient() {
  for (const l of lives.values()) l.source?.close();
  globalSource?.close();
  globalSource = null;
  lives.clear();
  stopped.clear();
  listeners.clear();
  allListeners.clear();
  ending.clear();
  generation.clear();
  waiters.clear();
}
