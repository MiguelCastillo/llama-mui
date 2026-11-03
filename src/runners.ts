// Plan runners: a plan runs here, not in the open Chat, so it keeps going when
// the user opens another session. No React in this file.
//
// One entry per session id, in a module-level store. The entry holds the live
// Session (a new object for every change, so a listener can compare by
// reference) and saves it, debounced; the pending ask; and the Pause state.
// The Session never holds anything secret: the connector and the rest of
// what a run needs (`RunnerEnv`) stay in the entry, out of what is saved.
//
// Status is derived, in this order:
//   stopped  the run ended, for any reason; the entry stays until dismissed
//            (or replaced by a new run)
//   waiting  an ask is pending (approval, access, location)
//   pausing  Pause was pressed; the step in flight and its check finish first
//   paused   the gate holds, before the next step
//   running
// Pause is only a runner status: it is not saved, and no step has it.

import {
  type AccessRequest,
  type Approval,
  type AttachmentTarget,
  type Connector,
  type Model,
  type PlanStep,
  type Session,
  type SessionSummary,
  type ToolContext,
  saveSession,
} from "./api";
import { type RunPlanCallbacks, runPlan } from "./agent/agent";
import { planRequestFor } from "./planThread";
import { attachedPaths, makeReply, modelLoaded } from "./runnerReply";

// What a tool call can wait on the user for, and their answer: allow or deny,
// or, for a path, the files or folders they picked in its place.
export type Ask =
  | { needsAccess: AccessRequest }
  | { needsLocation: { description: string; kind: AttachmentTarget["kind"] } }
  | { needsApproval: Approval };
export type Answer = boolean | AttachmentTarget[];

export type RunnerStatus = "running" | "pausing" | "paused" | "waiting" | "stopped";

// What Chat hands over when it starts a run. Kept in the entry, never saved.
export interface RunnerEnv {
  connector: Connector | null;
  model: string;
  models: Model[];
  toolContext: ToolContext;
  toolsOn: boolean;
  thinkOn: boolean;
  // Settings → Chat, "Fresh context for each plan step"; on unless false.
  freshSteps?: boolean;
}

// What a listener sees. A new object after every change.
export interface RunnerView {
  sessionId: string;
  session: Session;
  status: RunnerStatus;
  // The pending ask and the way to answer it; see answerAsk.
  ask: { ask: Ask; decide: (answer: Answer) => void } | null;
  error: string | null;
  // A request is in flight (a step's reply or its check).
  streaming: boolean;
  startedAt: number;
}

// The kinds of event subscribeAll gets: never one per token.
export type RunnerEventKind = "status" | "ask" | "saved" | "dismissed";
export interface RunnerEvent {
  id: string;
  kind: RunnerEventKind;
  // Null once dismissed.
  view: RunnerView | null;
  // The saved row, for "saved".
  summary?: SessionSummary;
}

// What a reply needs from its runner: the live session, a way to change it,
// and the run's ask and abort handling.
export interface RunnerHandle {
  sessionId: string;
  env: RunnerEnv;
  getSession: () => Session;
  edit: (fn: (s: Session) => Session) => void;
  setError: (err: string | null) => void;
  setAbort: (c: AbortController | null) => void;
  askUser: (ask: Ask, signal: AbortSignal) => Promise<Answer>;
  // True while runPlan runs; the plan tool reads it (see planFromCall).
  planRunningRef: { current: boolean };
  planRef: { current: PlanStep[] | null };
}

export interface RunnerDeps {
  // Runs the plan; runPlan unless a test passes a fake.
  run?: (callbacks: RunPlanCallbacks) => Promise<void>;
  // Saves the session; saveSession unless a test passes a fake.
  save?: (session: Session) => Promise<SessionSummary>;
  // Builds the function that runs one reply (see RunPlanCallbacks.reply);
  // makeReply in runnerReply.ts unless a test passes a fake.
  reply?: (handle: RunnerHandle) => RunPlanCallbacks["reply"];
  // Whether the model is loaded; modelLoaded in runnerReply.ts by default.
  modelLoaded?: (handle: RunnerHandle) => Promise<boolean>;
}

// A save comes this long after the last change, and at the latest this long
// after the first change since the previous save.
export const SAVE_DELAY = 800;
export const SAVE_MAX_WAIT = 5000;

interface Entry {
  id: string;
  session: Session;
  env: RunnerEnv;
  deps: Required<RunnerDeps>;
  handle: RunnerHandle;
  view: RunnerView;
  ask: RunnerView["ask"];
  error: string | null;
  controller: AbortController | null;
  startedAt: number;
  planRunning: { current: boolean };
  // Pause was pressed; `release` is set while the gate holds.
  pauseRequested: boolean;
  release: ((go: boolean) => void) | null;
  stopRequested: boolean;
  ended: boolean;
  // Dropped from the store: nothing more is saved or announced.
  dismissed: boolean;
  // The step in flight, and the one that was when Stop came.
  runningStep: string | null;
  stepAtStop: string | null;
  dirty: boolean;
  saving: Promise<void> | null;
  saveAgain: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  maxWait: ReturnType<typeof setTimeout> | null;
}

const store = new Map<string, Entry>();
const listeners = new Map<string, Set<(view: RunnerView) => void>>();
const allListeners = new Set<(event: RunnerEvent) => void>();

const live = (entry: Entry) => !entry.dismissed && store.get(entry.id) === entry;

function statusOf(e: Entry): RunnerStatus {
  if (e.ended) return "stopped";
  if (e.ask) return "waiting";
  if (e.pauseRequested) return e.release ? "paused" : "pausing";
  return "running";
}

// Builds a new view and tells the listeners. subscribeAll hears of a change in
// the ask or the status (an ask first), and of a save; plain edits only reach
// the session's own listeners.
function touch(e: Entry, saved?: SessionSummary) {
  if (!live(e)) return;
  const before = e.view;
  const view: RunnerView = {
    sessionId: e.id,
    session: e.session,
    status: statusOf(e),
    ask: e.ask,
    error: e.error,
    streaming: e.controller !== null,
    startedAt: e.startedAt,
  };
  e.view = view;
  for (const fn of [...(listeners.get(e.id) ?? [])]) fn(view);
  const kind: RunnerEventKind | null = saved
    ? "saved"
    : view.ask !== before.ask
      ? "ask"
      : view.status !== before.status
        ? "status"
        : null;
  if (kind) for (const fn of [...allListeners]) fn({ id: e.id, kind, view, summary: saved });
}

// ── saving ───────────────────────────────────────────────────────────────────

function clearSaveTimers(e: Entry) {
  if (e.debounce) clearTimeout(e.debounce);
  if (e.maxWait) clearTimeout(e.maxWait);
  e.debounce = e.maxWait = null;
}

// Saves now if there is anything unsaved. One save at a time per session, so
// an older copy never lands after a newer one; a change that comes while one
// is in flight is saved when it finishes.
function persist(e: Entry) {
  clearSaveTimers(e);
  if (e.dismissed || !e.dirty) return;
  if (e.saving) {
    e.saveAgain = true;
    return;
  }
  e.dirty = false;
  e.saving = e.deps
    .save(e.session)
    .then((summary) => touch(e, summary))
    .catch((err) => {
      e.error = `Couldn't save the session: ${err?.message ?? err}`;
      touch(e);
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
  if (e.dismissed) return;
  e.dirty = true;
  if (e.debounce) clearTimeout(e.debounce);
  e.debounce = setTimeout(() => persist(e), SAVE_DELAY);
  e.maxWait ??= setTimeout(() => persist(e), SAVE_MAX_WAIT);
}

// ── changing the session ─────────────────────────────────────────────────────

function change(e: Entry, fn: (s: Session) => Session) {
  const next = fn(e.session);
  if (next === e.session) return;
  e.session = next;
  scheduleSave(e);
  touch(e);
}

// Changes one step, keeping its text and summary (unless the patch sets a
// summary); the patch replaces the rest, like Chat's setStep did.
function patchStep(e: Entry, id: string, patch: Omit<PlanStep, "id" | "text">) {
  change(e, (s) =>
    s.plan?.some((st) => st.id === id)
      ? {
          ...s,
          plan: s.plan.map((st) =>
            st.id === id ? { id: st.id, text: st.text, ...(st.summary ? { summary: st.summary } : {}), ...patch } : st,
          ),
        }
      : s,
  );
}

// ── asks ─────────────────────────────────────────────────────────────────────

// Stores the ask and resolves with the user's answer. An aborted request
// counts as deny. Asks wait for as long as it takes; nothing pops up.
function askUser(e: Entry, ask: Ask, signal: AbortSignal): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    if (signal.aborted) return resolve(false);
    const decide = (answer: Answer) => {
      if (e.ask?.decide !== decide) return;
      signal.removeEventListener("abort", onAbort);
      e.ask = null;
      resolve(answer);
      touch(e);
    };
    const onAbort = () => decide(false);
    signal.addEventListener("abort", onAbort);
    e.ask = { ask, decide };
    touch(e);
  });
}

// ── the run ──────────────────────────────────────────────────────────────────

// Starts the plan of `session` (its open steps, in order) and returns its view.
// Chat's state at that moment goes in `session` and `env`; from then on the
// session lives here. A session that already has a running runner is left as
// it is; one that stopped is replaced.
export function startRunner(session: Session, env: RunnerEnv, deps: RunnerDeps = {}): RunnerView {
  const id = session.id;
  const existing = store.get(id);
  if (existing && !existing.ended) return existing.view;
  if (existing) {
    persist(existing);
    existing.dismissed = true;
  }

  const planRunning = { current: false };
  const resolved: Required<RunnerDeps> = {
    run: deps.run ?? runPlan,
    save: deps.save ?? saveSession,
    reply: deps.reply ?? makeReply,
    modelLoaded: deps.modelLoaded ?? modelLoaded,
  };
  const e = {
    id,
    session,
    env,
    deps: resolved,
    ask: null,
    error: null,
    controller: null,
    startedAt: Date.now(),
    planRunning,
    pauseRequested: false,
    release: null,
    stopRequested: false,
    ended: false,
    dismissed: false,
    runningStep: null,
    stepAtStop: null,
    dirty: false,
    saving: null,
    saveAgain: false,
    debounce: null,
    maxWait: null,
  } as unknown as Entry;
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
    getSession: () => e.session,
    edit: (fn) => change(e, fn),
    setError: (err) => {
      if (e.error === err) return;
      e.error = err;
      touch(e);
    },
    setAbort: (c) => {
      e.controller = c;
      touch(e);
    },
    askUser: (ask, signal) => askUser(e, ask, signal),
    planRunningRef: planRunning,
    planRef,
  };
  e.view = { sessionId: id, session, status: "running", ask: null, error: null, streaming: false, startedAt: e.startedAt };
  store.set(id, e);
  touch(e);
  // A replaced entry's listeners are told through the new view; subscribeAll
  // hears a status change.
  for (const fn of [...allListeners]) fn({ id, kind: "status", view: e.view });

  const reply = resolved.reply(e.handle);
  const callbacks: RunPlanCallbacks = {
    connector: env.connector,
    model: env.model,
    abort: null,
    planRunningRef: planRunning,
    // The status is derived from the run, so there is nothing to set.
    setPlanRunning: () => {},
    messages: session.messages,
    planRef,
    setStep: (stepId, patch) => {
      if (patch.status === "running") e.runningStep = stepId;
      else if (e.runningStep === stepId) e.runningStep = null;
      patchStep(e, stepId, patch);
    },
    // After Stop nothing more is sent.
    reply: async (text, before, opts) =>
      e.stopRequested ? { ok: false, messages: before } : reply(text, before, opts),
    request: planRequestFor(session.messages, session.planAnchor),
    context: session.planContext,
    freshSteps: env.freshSteps,
    setError: e.handle.setError,
    setAbort: e.handle.setAbort,
    modelLoaded: async () => !e.stopRequested && resolved.modelLoaded(e.handle),
    models: env.models,
    attachments: session.attachments,
    checkCommands: env.toolContext.checkCommands,
    attachedPaths,
    sessionId: id,
    thinkOn: env.thinkOn,
    toolDefinitions: env.toolContext.definitions,
    // Pause holds here, before the next step; Stop ends the plan.
    gate: () => {
      if (e.stopRequested) return Promise.resolve(false);
      if (!e.pauseRequested) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        e.release = (go) => {
          e.release = null;
          resolve(go);
        };
        touch(e);
      });
    },
  };

  resolved
    .run(callbacks)
    .catch((err) => {
      if (!e.stopRequested) e.handle.setError(String(err?.message ?? err));
    })
    .finally(() => end(e));
  return e.view;
}

// The run is over: whatever the reason, the entry stays, stopped, with the
// final session saved.
function end(e: Entry) {
  if (e.ended || e.dismissed) return;
  // The step Stop interrupted waits to run again, and says why.
  const stopped = e.stepAtStop && e.session.plan?.find((st) => st.id === e.stepAtStop);
  if (stopped && (stopped.status === "pending" || stopped.status === "running")) {
    const keep = stopped.answer ? { answer: stopped.answer, asked: stopped.asked } : {};
    patchStep(e, stopped.id, { status: "pending", note: "Stopped", ...keep });
  }
  e.ended = true;
  e.runningStep = null;
  e.controller = null;
  e.release?.(false);
  e.ask?.decide(false);
  persist(e);
  touch(e);
}

// ── the API ──────────────────────────────────────────────────────────────────

export const getView = (id: string): RunnerView | undefined => store.get(id)?.view;

// Every runner's view, for Chat's "needs you" dots.
export const allViews = (): RunnerView[] => [...store.values()].map((e) => e.view);

// Calls fn with the view after every change to this session's runner,
// including each streamed piece. Returns the way to stop listening. It keeps
// listening across runs: a new run for the id is announced too.
export function subscribe(id: string, fn: (view: RunnerView) => void): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size && listeners.get(id) === set) listeners.delete(id);
  };
}

// Calls fn when any runner's status or ask changes, when one is saved and
// when one is dismissed: never per streamed piece.
export function subscribeAll(fn: (event: RunnerEvent) => void): () => void {
  allListeners.add(fn);
  return () => allListeners.delete(fn);
}

// Pause: the step in flight and its check finish, then the run holds before
// the next step. Only for a run that hasn't ended.
export function pause(id: string) {
  const e = store.get(id);
  if (!e || e.ended || e.pauseRequested) return;
  e.pauseRequested = true;
  touch(e);
}

export function resume(id: string) {
  const e = store.get(id);
  if (!e || e.ended || !e.pauseRequested) return;
  e.pauseRequested = false;
  e.release?.(true);
  touch(e);
}

// Stop is immediate: the request is aborted, a held gate and a pending ask are
// released. The run is over once runPlan returns (status stopped); the step in
// flight stays pending, with the note "Stopped".
export function stop(id: string) {
  const e = store.get(id);
  if (!e || e.ended || e.stopRequested) return;
  e.stopRequested = true;
  e.stepAtStop = e.runningStep;
  e.controller?.abort();
  e.ask?.decide(false);
  e.release?.(false);
  touch(e);
}

// The user's answer to the pending ask; ignored when there is none.
export function answerAsk(id: string, answer: Answer) {
  store.get(id)?.ask?.decide(answer);
}

// Changes the live session (a step edited, an attachment added) the way Chat
// would have changed its own state. fn returns the new Session, or the same one.
export function edit(id: string, fn: (s: Session) => Session) {
  const e = store.get(id);
  if (e) change(e, fn);
}

// Drops the entry. A stopped run's last changes are saved first. A run that is
// still going is stopped without saving anything more (for a deleted session).
// Resolves once a save that was already under way has finished.
export function dismiss(id: string): Promise<void> {
  const e = store.get(id);
  if (!e) return Promise.resolve();
  if (e.ended) {
    persist(e);
  } else {
    e.stopRequested = true;
    e.dismissed = true;
    e.controller?.abort();
    e.ask?.decide(false);
    e.release?.(false);
  }
  clearSaveTimers(e);
  const saving = e.saving ?? Promise.resolve();
  e.dismissed = true;
  store.delete(id);
  for (const fn of [...allListeners]) fn({ id, kind: "dismissed", view: null });
  return saving;
}

// ── what the UI shows ────────────────────────────────────────────────────────

// A runner needs the user when it waits on an ask, or stopped with a step
// that asked a question (a waiting step).
export function needsYou(view: RunnerView | undefined | null): boolean {
  if (!view) return false;
  if (view.ask) return true;
  return view.status === "stopped" && !!view.session.plan?.some((st) => st.status === "waiting");
}

// The plan card's Pause control: a short caption, and the button, if any.
// Pause only while running; Resume while paused. While it is pausing, or
// waiting on an ask, there is nothing to press.
export function pauseControl(status: RunnerStatus | undefined | null): {
  text: string | null;
  button: "Pause" | "Resume" | null;
} {
  switch (status) {
    case "running":
      return { text: null, button: "Pause" };
    case "pausing":
      return { text: "Pausing after this step", button: null };
    case "paused":
      return { text: "Paused", button: "Resume" };
    default:
      return { text: null, button: null };
  }
}

// For tests: drops every entry and listener without saving.
export function resetRunners() {
  for (const e of store.values()) {
    e.dismissed = true;
    e.stopRequested = true;
    e.controller?.abort();
    e.release?.(false);
    clearSaveTimers(e);
  }
  store.clear();
  listeners.clear();
  allListeners.clear();
}
