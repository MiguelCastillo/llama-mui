// The run hub: who owns a session right now.
//
// A session is normally the page's: it saves the whole thing with PUT. While a
// plan runs on the server, the run owns it instead: the page's saves are
// refused, and the run (or a rename, through the run's live session) is the
// only writer. The hub keeps three things for that:
//
//  - a revision, an integer in session.json that goes up by one on every write
//    the server does (a session saved before this has none, which counts as 0).
//    A page sends the revision it loaded; if the file has moved on, its save is
//    refused instead of overwriting newer work.
//  - the live runs, in memory only. A `run` record left in session.json by a
//    crash is just data and never blocks a save; only a run in this process does.
//  - an event bus the SSE routes read from: status, ask, saved, removed (and,
//    for the runner to publish later, step, session, thread and ack).
//
// The run record in session.json is { status, startedAt, ask?, streaming?, error? }: plain data, no
// functions, and nothing secret (the server never hands a run an API key).
// Every write goes through one queue per session, so a check of the revision and
// the write that follows it can't be split by another request.

import { HttpError } from "./http.ts";
import { readSession, revisionOf, summaryOf, writeSession } from "./sessionFile.ts";
import { copyForEvents, diffSession } from "./sessionPatch.ts";

export type RunStatus = "running" | "waiting" | "stopped";

// A question the run is waiting on, as plain data. Whatever answers it stays in
// memory; a command with this id is what resolves it.
export interface RunAsk {
  id: string;
  kind: "access" | "location" | "approval";
  details: unknown;
}

// A message the user sent to the running plan that no step has seen yet: what
// they typed (their own words, nothing secret), and the step that will see it.
export interface RunNote {
  id: string;
  text: string;
  step: number; // counting from 1
  stepId: string;
}

export interface RunState {
  status: RunStatus;
  startedAt: number;
  // "turn": the run is one chat reply (a message sent to a session with no
  // plan running), not a plan. Missing means a plan, as in older records.
  kind?: "turn";
  ask?: RunAsk;
  // Messages waiting for the next step (see runners.ts, sendNote).
  notes?: RunNote[];
  // A request is in flight (a step's reply or its check).
  streaming?: boolean;
  // What went wrong, in the run's plain words (never a key: the run doesn't have one).
  error?: string;
}

export type HubEventType = "status" | "step" | "ask" | "session" | "saved" | "removed" | "thread" | "ack";

export interface HubEvent {
  type: HubEventType;
  id: string; // the session
  data: Record<string, unknown>;
}

interface Live {
  state: RunState;
  // The run's own copy of the session, if it keeps one in memory. Edits made
  // while it runs go into this object, so its next save doesn't undo them.
  session?: () => any;
  // The session as the last `session` event left it (a copy), and the timer of
  // the event that is waiting to go out.
  sent?: any;
  timer?: ReturnType<typeof setTimeout>;
}

// The longest a change waits before it is sent: a streaming reply makes about
// ten events a second, however many pieces arrive.
export const SESSION_EVENT_MS = 100;

const runs = new Map<string, Live>();
const listeners = new Set<(e: HubEvent) => void>();

export function subscribe(listener: (e: HubEvent) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// For tests: that a closed stream has let go of its listener.
export const listenerCount = () => listeners.size;

export function publish(e: HubEvent) {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch (err) {
      console.warn(`A listener for a ${e.type} event failed: ${err}`);
    }
  }
}

// A copy that is safe to hand out and to write: plain data only.
const copyRun = (s: RunState): RunState => JSON.parse(JSON.stringify(s));

export const liveRun = (id: string): RunState | null => {
  const live = runs.get(id);
  return live ? copyRun(live.state) : null;
};

// Every session with a run in this process, for a page that has just connected.
export const liveRuns = (): { id: string; run: RunState }[] =>
  [...runs].map(([id, live]) => ({ id, run: copyRun(live.state) }));

// What a page that opens one session's event stream starts from, and the
// listener that carries on from exactly there. It is read while no write is
// under way and the listener is added in the same step, so no event is missed
// and none is older than the snapshot. A run's own copy of the session is the
// newest one there is, so it is used while a run is live. Null if the session
// isn't saved. `run` and `revision` are the server's, so they sit beside the
// session rather than in it.
export function watch(
  id: string,
  listener: (e: HubEvent) => void,
): Promise<{ session: any; revision: number; run: RunState | null; stop: () => void } | null> {
  return locked(id, async () => {
    const prev = await readSession(id);
    if (!prev) return null;
    const live = runs.get(id);
    const session = copyForEvents(live?.session?.() ?? prev);
    const run = live ? copyRun(live.state) : null;
    const unsubscribe = subscribe((e) => void (e.id === id && listener(e)));
    return { session, revision: revisionOf(prev), run, stop: unsubscribe };
  });
}

// Tells pages the run's session changed, as a patch (see sessionPatch.ts). The
// run calls this after every change to its in-memory session; the event goes
// out within SESSION_EVENT_MS, however many calls came before it.
export function announce(id: string) {
  const live = runs.get(id);
  if (!live?.session || live.timer) return;
  live.timer = setTimeout(() => flushAnnounce(id), SESSION_EVENT_MS);
}

// Sends what changed now, without waiting for the timer.
export function flushAnnounce(id: string) {
  const live = runs.get(id);
  if (!live?.session) return;
  if (live.timer) clearTimeout(live.timer);
  live.timer = undefined;
  const next = copyForEvents(live.session());
  const patch = live.sent ? diffSession(live.sent, next) : null;
  live.sent = next;
  if (patch) publish({ type: "session", id, data: { patch } });
}

// One queue per session id. Don't call a locked function from inside another.
const tails = new Map<string, Promise<unknown>>();
export function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const result = (tails.get(id) ?? Promise.resolve()).then(fn);
  const tail = result.catch(() => {});
  tails.set(id, tail);
  void tail.then(() => {
    if (tails.get(id) === tail) tails.delete(id);
  });
  return result;
}

export interface Saved {
  session: any;
  revision: number;
}

// Writes `session` as the next revision. `run` and `revision` are the
// server's: whatever the caller's copy says is replaced, by the live run's
// state (gone once it has ended: `runOver`), or by what the file already had (so a stale record is kept for a
// restart to find, and never made up by a page).
async function commit(id: string, session: any, prev: any | null, runOver = false): Promise<Saved> {
  const revision = revisionOf(prev) + 1;
  const out = { ...session, revision };
  const live = runs.get(id);
  const run = live ? copyRun(live.state) : runOver ? undefined : prev?.run;
  if (run) out.run = run;
  else delete out.run;
  await writeSession(id, out);
  publish({ type: "saved", id, data: { summary: summaryOf(out), revision } });
  return { session: out, revision };
}

// The revision on disk now (0 if the session isn't saved, or has none).
export const currentRevision = (id: string): Promise<number> => locked(id, async () => revisionOf(await readSession(id)));

// Saves a session as asked by the page (PUT). `build` gets what's on disk (or
// null) and returns the new session. `sentRevision` is the one the page
// loaded; leave it out for a client that doesn't track revisions.
export function replace(
  id: string,
  build: (old: any | null) => any,
  sentRevision?: number,
): Promise<Saved> {
  return locked(id, async () => {
    if (runs.has(id)) {
      throw new HttpError(409, "A plan is running in this session, so this page can't save it. It shows the run instead.", {
        reason: "run active",
      });
    }
    const old = await readSession(id);
    if (sentRevision !== undefined && old && sentRevision !== revisionOf(old)) {
      throw new HttpError(409, "This session changed somewhere else since this page loaded it.", {
        reason: "stale revision",
        revision: revisionOf(old),
      });
    }
    return commit(id, build(old), old);
  });
}

// Changes a session as its owner: through the live run's own copy while one
// runs, or on the file otherwise. `edit` changes the object it is given.
export function edit(id: string, change: (session: any) => void): Promise<Saved> {
  return locked(id, async () => {
    const prev = await readSession(id);
    if (!prev) throw new HttpError(404, "No such session");
    const base = runs.get(id)?.session?.() ?? prev;
    change(base);
    announce(id); // a rename during a run reaches the pages that show it
    return commit(id, base, prev);
  });
}

// The run's own save: writes its in-memory session as the next revision.
export function save(id: string, session: any): Promise<Saved> {
  return locked(id, async () => {
    const prev = await readSession(id);
    if (!prev) throw new HttpError(404, "No such session");
    return commit(id, session, prev);
  });
}

// Marks a session as running. Refused if it already is (a second window
// starting the same plan). `expectRevision`: the revision the run's copy of the
// session was read at; if a save has landed since, the run is refused rather
// than writing its older copy over it.
export function beginRun(
  id: string,
  opts: { status?: RunStatus; session?: () => any; expectRevision?: number; kind?: "plan" | "turn" } = {},
): Promise<RunState> {
  return locked(id, async () => {
    if (runs.has(id)) throw new HttpError(409, "This plan is already running.", { reason: "already running" });
    const prev = await readSession(id);
    if (!prev) throw new HttpError(404, "No such session");
    if (opts.expectRevision !== undefined && opts.expectRevision !== revisionOf(prev)) {
      throw new HttpError(409, "This session changed just now, so the plan wasn't started. Try again.", {
        reason: "stale revision",
        revision: revisionOf(prev),
      });
    }
    const live: Live = {
      state: { status: opts.status ?? "running", startedAt: Date.now(), ...(opts.kind === "turn" ? { kind: "turn" as const } : {}) },
      session: opts.session,
    };
    if (live.session) live.sent = copyForEvents(live.session());
    runs.set(id, live);
    try {
      await commit(id, live.session?.() ?? prev, prev);
    } catch (e) {
      runs.delete(id); // not running after all
      throw e;
    }
    publish({ type: "status", id, data: { run: copyRun(live.state) } });
    return copyRun(live.state);
  });
}

// Changes the run's status, its pending question (`ask: null` clears it), and
// whether a request is in flight and the error shown (`error: null` clears it).
export function updateRun(
  id: string,
  patch: { status?: RunStatus; ask?: RunAsk | null; streaming?: boolean; error?: string | null; notes?: RunNote[] },
): Promise<RunState> {
  return locked(id, async () => {
    const live = runs.get(id);
    if (!live) throw new Error(`No run is live for session ${id}`);
    if (patch.status) live.state.status = patch.status;
    if (patch.notes) {
      if (patch.notes.length) live.state.notes = JSON.parse(JSON.stringify(patch.notes));
      else delete live.state.notes;
    }
    if (patch.streaming !== undefined) {
      if (patch.streaming) live.state.streaming = true;
      else delete live.state.streaming;
    }
    if ("error" in patch) {
      if (patch.error) live.state.error = patch.error;
      else delete live.state.error;
    }
    if ("ask" in patch) {
      if (patch.ask) live.state.ask = JSON.parse(JSON.stringify(patch.ask));
      else delete live.state.ask;
    }
    const prev = await readSession(id);
    if (prev) await commit(id, live.session?.() ?? prev, prev);
    publish({ type: "status", id, data: { run: copyRun(live.state) } });
    if ("ask" in patch) publish({ type: "ask", id, data: { ask: live.state.ask ? copyRun(live.state).ask : null } });
    return copyRun(live.state);
  });
}

// The run is over: the session is the page's again. Its record leaves
// session.json, and a final save of the run's session goes out with it. `error`
// is how the run ended, if badly; it goes out with the status event, since
// the run record that held it is gone.
export function endRun(id: string, opts: { error?: string | null } = {}): Promise<void> {
  return locked(id, async () => {
    const live = runs.get(id);
    if (!live) return;
    flushAnnounce(id); // the last changes reach pages before the run is over
    runs.delete(id);
    const prev = await readSession(id);
    if (prev) await commit(id, live.session?.() ?? prev, prev, true);
    publish({ type: "status", id, data: opts.error ? { run: null, error: opts.error } : { run: null } });
  });
}

// For a restart: a session whose file still has a run record from a process
// that is gone. `fix` gets a copy of the session and that record and returns the
// session to save, which is written as the next revision without the record.
// Nothing happens (false) if the session has no such record, or has a run in
// this process (a run that began since the server started is not stale).
export function settleStale(id: string, fix: (session: any, run: RunState) => any): Promise<boolean> {
  return locked(id, async () => {
    if (runs.has(id)) return false;
    const prev = await readSession(id);
    if (!prev?.run) return false;
    await commit(id, fix(JSON.parse(JSON.stringify(prev)), prev.run), prev, true);
    return true;
  });
}

// Deletes a session's file (the sessions route removes the folder after).
// Refused while a run is live: stop it first.
export function remove(id: string, deleteFile: () => Promise<void>): Promise<void> {
  return locked(id, async () => {
    if (runs.has(id)) throw new HttpError(409, "A plan is running in this session. Stop it first.", { reason: "run active" });
    await deleteFile();
    publish({ type: "removed", id, data: {} });
  });
}
