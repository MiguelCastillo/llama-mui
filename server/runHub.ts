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
// The run record in session.json is { status, startedAt, owner?, ask?, streaming?, error? }: plain data, no
// functions, and nothing secret (the server never hands a run an API key).
// Every write goes through one queue per session, so a check of the revision and
// the write that follows it can't be split by another request.

import type { EndKind } from "../src/runEnd.ts";
import { auditSessionDeleted } from "./audit.ts";
import { setChangedFileSink } from "./changedFiles.ts";
import { HttpError } from "./http.ts";
import { lockSession, readSession, revisionOf, summaryOf, writeSession } from "./sessionFile.ts";
import { copyForEvents, diffSession } from "./sessionPatch.ts";
import { CHECK_IN_MS, fileRunStore, holderOf, ownerAlive, ownerNow, serverId, type RunOwner } from "./runRecord.ts";

// The port this server listens on, put in the owner field of every run it
// begins. 0 until the server says (setOwnerPort).
let ownerPort = 0;
export const setOwnerPort = (port: number) => void (ownerPort = port);

export type RunStatus = "running" | "waiting" | "stopped";

// A question the run is waiting on, as plain data. Whatever answers it stays in
// memory; a command with this id is what resolves it.
export interface RunAsk {
  id: string;
  kind: "access" | "location" | "approval";
  details: unknown;
  // The user's answer, written by whichever server's page took it (the first
  // one only). The owning server picks it up from the record.
  answer?: { value: unknown; at: number; by: number };
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
  // The server running this: its process id and port, and when it last checked
  // in (see runRecord.ts). Missing in records written by an older build.
  owner?: RunOwner;
  // "turn": the run is one chat reply (a message sent to a session with no
  // plan running), not a plan. Missing means a plan, as in older records.
  kind?: "turn";
  // The code that started this run marks a changing call as started before it
  // runs it. Missing in records written by an older build, which doesn't.
  marksCalls?: boolean;
  ask?: RunAsk;
  // Messages waiting for the next step (see runners.ts, sendNote).
  notes?: RunNote[];
  // A request is in flight (a step's reply or its check).
  streaming?: boolean;
  // What that request is: a reply being written, or the check after a step.
  // Missing in records written by an older build.
  request?: "reply" | "check";
  // Stop was pressed and the run is finishing what is in flight.
  stopping?: boolean;
  // A side question is being answered beside the plan (see aside.ts).
  aside?: boolean;
  // What went wrong, in the run's plain words (never a key: the run doesn't have one).
  error?: string;
  // Why the run was cut short (see src/runEnd.ts), written when it is, so
  // another server that settles or takes over the run can show the same line.
  endedBy?: EndKind;
  // Paths of the files this run changed, oldest first, each once (see
  // changedFiles.ts). Read by the note a restart leaves on an interrupted step.
  changed?: string[];
}

const MAX_CHANGED = 200;

// Adds a file to the live run's list, in memory and in the record. Only a run
// in this process has a list to add to; anything else is ignored. Not awaited
// by the file change that triggers it, so it can't hold up (or deadlock with)
// a write made while the session is locked.
export function noteChanged(id: string, path: string): Promise<void> {
  return locked(id, async () => {
    const live = runs.get(id);
    if (!live) return;
    const list = live.state.changed ?? (live.state.changed = []);
    if (list.includes(path) || list.length >= MAX_CHANGED) return;
    list.push(path);
    try {
      await fileRunStore.update(id, (run) => void (run.changed = [...list]));
    } catch (e) {
      console.warn(`Couldn't note a changed file for session ${id}: ${e}`);
    }
  });
}

setChangedFileSink((session, path) => void noteChanged(session, path).catch(() => {}));

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
  // Checks in on the run record every CHECK_IN_MS while the run is live.
  beat?: ReturnType<typeof setInterval>;
}

// Updates the owner's check-in time, in memory and in the record on disk. Only
// the owner field is written; nothing is published.
//
// First it checks that the record still exists and names this server. If it is
// gone, or names another holder (someone took over), this run no longer holds
// the floor: it is dropped from memory, its check-in stops, whoever runs it is
// told (setLostFloorHandler) and nothing of it is saved again.
export function checkIn(id: string): Promise<void> {
  return locked(id, async () => {
    const live = runs.get(id);
    if (!live) return;
    try {
      const record = await fileRunStore.read(id);
      if (!record || record.owner?.serverId !== serverId) {
        loseFloor(id, live);
        return;
      }
      const owner = ownerNow(ownerPort);
      live.state.owner = owner;
      await fileRunStore.update(id, (run) => void (run.owner = owner));
    } catch (e) {
      console.warn(`Check-in for session ${id} failed: ${e}`);
    }
  });
}

// Sessions whose run in this process lost the floor. Saves for them are refused
// until this server begins a new run in the session.
const lostFloor = new Set<string>();
let onLostFloor: (id: string) => void = () => {};

// The runner registers here to stop the work of a run that lost the floor.
export const setLostFloorHandler = (fn: (id: string) => void) => void (onLostFloor = fn);

const lostFloorError = () =>
  new HttpError(409, "Another server took over this run, so this one no longer saves it.", { reason: "lost the floor" });

function loseFloor(id: string, live: Live) {
  if (live.beat) clearInterval(live.beat);
  if (live.timer) clearTimeout(live.timer);
  live.timer = undefined;
  runs.delete(id);
  lostFloor.add(id);
  try {
    onLostFloor(id);
  } catch (e) {
    console.warn(`Couldn't stop the run of session ${id} that lost the floor: ${e}`);
  }
  publish({ type: "status", id, data: { run: null } });
}

function startBeat(id: string, live: Live) {
  live.beat = setInterval(() => void checkIn(id), CHECK_IN_MS);
  live.beat.unref?.();
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
    // No run here: a record whose owner is alive is another server's run, shown
    // as the run (the same as opening the session does), so nobody is told "no run".
    const recorded = prev.run && typeof prev.run === "object" && ownerAlive(prev.run) ? (copyRun(prev.run) as RunState) : null;
    const run = live ? copyRun(live.state) : recorded;
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

// One queue per session id, and inside it a lock file shared with other
// llama-mui processes on this folder (lockSession), held only while `fn` runs.
// Don't call a locked function from inside another.
const tails = new Map<string, Promise<unknown>>();
export function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const result = (tails.get(id) ?? Promise.resolve()).then(() => lockSession(id, fn));
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
async function commit(id: string, session: any, prev: any | null, runOver = false, sync = false, starting = false): Promise<Saved> {
  const live = runs.get(id);
  // A live run writes only while the record on disk still names this server.
  // Between check-ins another server may have taken over: then this run is
  // dropped here and nothing is written over the new holder's state.
  if (live && !starting && prev?.run?.owner?.serverId !== serverId) {
    loseFloor(id, live);
    throw lostFloorError();
  }
  const revision = revisionOf(prev) + 1;
  const out = { ...session, revision };
  const run = live ? copyRun(live.state) : runOver ? undefined : prev?.run;
  // An answer another server wrote to the record since this run last did is
  // not lost by this write.
  const written = prev?.run?.ask;
  if (live && run?.ask && !run.ask.answer && written?.id === run.ask.id && written.answer) run.ask.answer = written.answer;
  if (run) out.run = run;
  else delete out.run;
  await writeSession(id, out, sync ? { sync } : {});
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
// `sync`: resolves only once the disk has it (a write that must outlive a crash).
export function save(id: string, session: any, opts: { sync?: boolean } = {}): Promise<Saved> {
  return locked(id, async () => {
    if (lostFloor.has(id)) throw lostFloorError();
    const prev = await readSession(id);
    if (!prev) throw new HttpError(404, "No such session");
    return commit(id, session, prev, false, !!opts.sync);
  });
}

// Marks a session as running. Refused if it already is (a second window
// starting the same plan). `expectRevision`: the revision the run's copy of the
// session was read at; if a save has landed since, the run is refused rather
// than writing its older copy over it.
export function beginRun(
  id: string,
  opts: { status?: RunStatus; session?: () => any; expectRevision?: number; kind?: "plan" | "turn"; marksCalls?: boolean } = {},
): Promise<RunState> {
  return locked(id, async () => {
    if (runs.has(id)) throw new HttpError(409, "This plan is already running.", { reason: "already running" });
    lostFloor.delete(id);
    const prev = await readSession(id);
    if (!prev) throw new HttpError(404, "No such session");
    // Another server is running this session right now: a second run would
    // overwrite its work.
    if (prev.run && ownerAlive(prev.run)) {
      throw new HttpError(409, "This session is already running on another server. Wait for it to finish, or stop it there.", {
        reason: "running elsewhere",
      });
    }
    if (opts.expectRevision !== undefined && opts.expectRevision !== revisionOf(prev)) {
      throw new HttpError(409, "This session changed just now, so the plan wasn't started. Try again.", {
        reason: "stale revision",
        revision: revisionOf(prev),
      });
    }
    const live: Live = {
      state: { status: opts.status ?? "running", startedAt: Date.now(),
        owner: ownerNow(ownerPort),
        ...(opts.kind === "turn" ? { kind: "turn" as const } : {}),
        ...(opts.marksCalls ? { marksCalls: true } : {}),
      },
      session: opts.session,
    };
    if (live.session) live.sent = copyForEvents(live.session());
    runs.set(id, live);
    try {
      await commit(id, live.session?.() ?? prev, prev, false, false, true);
    } catch (e) {
      runs.delete(id); // not running after all
      throw e;
    }
    startBeat(id, live);
    publish({ type: "status", id, data: { run: copyRun(live.state) } });
    return copyRun(live.state);
  });
}

// Changes the run's status, its pending question (`ask: null` clears it), and
// whether a request is in flight and the error shown (`error: null` clears it).
export function updateRun(
  id: string,
  patch: { status?: RunStatus; ask?: RunAsk | null; streaming?: boolean; request?: "reply" | "check" | null; stopping?: boolean; aside?: boolean; error?: string | null; notes?: RunNote[]; endedBy?: EndKind },
): Promise<RunState> {
  return locked(id, async () => {
    const live = runs.get(id);
    if (!live) throw new Error(`No run is live for session ${id}`);
    if (patch.status) live.state.status = patch.status;
    if (patch.endedBy) live.state.endedBy = patch.endedBy;
    if (patch.notes) {
      if (patch.notes.length) live.state.notes = JSON.parse(JSON.stringify(patch.notes));
      else delete live.state.notes;
    }
    if (patch.streaming !== undefined) {
      if (patch.streaming) live.state.streaming = true;
      else delete live.state.streaming;
    }
    if (patch.request !== undefined) {
      if (patch.request) live.state.request = patch.request;
      else delete live.state.request;
    }
    if (patch.stopping !== undefined) {
      if (patch.stopping) live.state.stopping = true;
      else delete live.state.stopping;
    }
    if (patch.aside !== undefined) {
      if (patch.aside) live.state.aside = true;
      else delete live.state.aside;
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

export type AnswerOutcome =
  | { result: "none" } // no run with a live owner
  | { result: "stale" } // that question isn't the pending one
  | { result: "late"; ask: RunAsk } // it was answered already
  | { result: "taken"; ask: RunAsk };

// Writes the user's answer into the run record, from any server. The first
// answer wins: once the record holds one, later ones are "late". `validate`
// may return an HttpError for an answer of the wrong kind, which is thrown
// before anything is written. The owner picks the answer up (pendingAnswer).
export function submitAnswer(
  id: string,
  askId: string,
  value: unknown,
  validate: (ask: RunAsk) => HttpError | null,
): Promise<AnswerOutcome> {
  return locked(id, async () => {
    const run = await fileRunStore.read(id);
    if (!run || !ownerAlive(run)) return { result: "none" };
    const ask = run.ask as RunAsk | undefined;
    if (!ask || ask.id !== askId) return { result: "stale" };
    if (ask.answer) return { result: "late", ask };
    const bad = validate(ask);
    if (bad) throw bad;
    const answer = { value, at: Date.now(), by: process.pid };
    await fileRunStore.update(id, (r) => void (r.ask.answer = answer));
    const live = runs.get(id);
    if (live?.state.ask?.id === askId) live.state.ask.answer = answer;
    return { result: "taken", ask };
  });
}

// The answer the record holds for that ask, if any (what the owner polls for).
export async function pendingAnswer(id: string, askId: string): Promise<{ value: unknown } | null> {
  const ask = (await fileRunStore.read(id))?.ask;
  return ask && ask.id === askId && ask.answer ? { value: ask.answer.value } : null;
}

// The run is over: the session is the page's again. Its record leaves
// session.json, and a final save of the run's session goes out with it. `error`
// is how the run ended, if badly; it goes out with the status event, since
// the run record that held it is gone.
export function endRun(id: string, opts: { error?: string | null } = {}): Promise<void> {
  return locked(id, async () => {
    const live = runs.get(id);
    if (!live) return;
    const prev = await readSession(id);
    if (prev?.run?.owner?.serverId !== serverId) {
      loseFloor(id, live); // someone took over: no final save, no record change
      return;
    }
    flushAnnounce(id); // the last changes reach pages before the run is over
    if (live.beat) clearInterval(live.beat);
    runs.delete(id);
    if (prev) await commit(id, live.session?.() ?? prev, prev, true);
    publish({ type: "status", id, data: opts.error ? { run: null, error: opts.error } : { run: null } });
  });
}

// A session whose file has a run record whose owner is dead (no check-in for
// 20 seconds, see ownerAlive). `fix` gets a copy of the session and that record
// and returns the session to save, which is written as the next revision without
// the record. Nothing happens (false) if the session has no record, has a run in
// this process, or its owner is alive: a run that another server is going on
// with is not stale, only absent from this process's memory. `now` is for tests.
export function settleStale(id: string, fix: (session: any, run: RunState) => any, now: number = Date.now()): Promise<boolean> {
  return locked(id, async () => {
    if (runs.has(id)) return false;
    const prev = await readSession(id);
    const run = await fileRunStore.read(id);
    if (!prev || !run || ownerAlive(run, now)) return false;
    await commit(id, fix(JSON.parse(JSON.stringify(prev)), run as RunState), prev, true);
    return true;
  });
}

// The user takes the floor from another server's live run: `fix` gets a copy of
// the session and the run's record and returns the session to save, which is
// written without the record at once, with no 20-second wait. The old holder
// finds the record gone at its next check-in and stops. Refused (409,
// "not running") when no run is live in the record or this server holds it.
export function takeOver(
  id: string,
  fix: (session: any, run: RunState) => any,
): Promise<{ port: number; kind: RunState["kind"]; session: any }> {
  return locked(id, async () => {
    const prev = await readSession(id);
    const run = await fileRunStore.read(id);
    const holder = holderOf(run);
    if (runs.has(id) || !prev || !run || !holder || holder.mine) {
      throw new HttpError(409, holder?.mine || runs.has(id) ? "This server is running this session, so there is nothing to take over." : "No other server is running this session.", {
        reason: "not running elsewhere",
      });
    }
    const session = fix(JSON.parse(JSON.stringify(prev)), run as RunState);
    await commit(id, session, prev, true);
    // The record is gone: tell this server's pages the run has ended, so the
    // "running elsewhere" line clears and the session is read again.
    publish({ type: "status", id, data: { run: null } });
    return { port: holder.port, kind: run.kind, session };
  });
}

// For a restart: a session that has messages waiting in its queue and no run in
// this process is left paused, so nothing in it is sent by itself. Writes the
// next revision only if it changes something; true if it did.
export function pauseQueue(id: string): Promise<boolean> {
  return locked(id, async () => {
    if (runs.has(id)) return false;
    const prev = await readSession(id);
    if (!prev || !Array.isArray(prev.queue) || !prev.queue.length || prev.queuePaused === true) return false;
    if (ownerAlive(prev.run)) return false; // another server is running it
    await commit(id, { ...prev, queuePaused: true }, prev, true);
    return true;
  });
}

// Deletes a session's file (the sessions route removes the folder after).
// Refused while a run is live: stop it first.
export function remove(id: string, deleteFile: () => Promise<void>, family?: string[]): Promise<void> {
  return locked(id, async () => {
    if (runs.has(id)) throw new HttpError(409, "A plan is running in this session. Stop it first.", { reason: "run active" });
    auditSessionDeleted(id, family); // while the file can still be read
    await deleteFile();
    publish({ type: "removed", id, data: {} });
  });
}
