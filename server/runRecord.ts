// Where a session's run record is kept: one small interface, so the place can
// change later (a database, say) without touching the code that uses it.
//
// Today the record is the `run` field inside the session's session.json. The
// record is plain data (see RunState in runHub.ts) and carries who owns the run:
// the process id and port of the server running it, and when that server last
// checked in. Whether an owner counts as alive is decided elsewhere, from
// `checkedAt`; this file only stores.
//
// These calls take no lock of their own. The caller holds the session's lock
// (runHub.ts, `locked`), so a read and the write after it can't be split.
// Writing the record counts as a server write: the session's revision goes up.
//
// Boundary rule: this file never reads the audit. Recovery depends on it.

import { randomUUID } from "node:crypto";
import { HttpError } from "./http.ts";
import { readSession, revisionOf, writeSession } from "./sessionFile.ts";

// Who is running the run, and the last time they said so.
export interface RunOwner {
  pid: number; // process id of the owning server
  port: number; // the port that server listens on (0 if not known)
  checkedAt: number; // ms since the epoch, of the owner's last check-in
  serverId?: string; // fresh at each server start-up; missing in older records
}

// This server's id, made fresh each time the server starts. A restarted server
// has a new one, so it is a stranger to the run its earlier self left behind.
export const serverId: string = randomUUID();

// The owner fields this server writes into a record.
export const ownerNow = (port: number): RunOwner => ({ pid: process.pid, port, checkedAt: Date.now(), serverId });

// The record, as stored. `RunState` in runHub.ts is the same data plus the
// owner fields; kept loose here so this file doesn't depend on the hub.
export type RunRecord = { startedAt: number; owner?: RunOwner } & Record<string, any>;

export interface RunRecordStore {
  // The record, or null if the session has none (or isn't saved).
  read(id: string): Promise<RunRecord | null>;
  // Saves `run` as the session's record, replacing any. 404 if no such session.
  write(id: string, run: RunRecord): Promise<RunRecord>;
  // Reads the record, lets `change` modify a copy (return nothing) or return a
  // replacement, and saves it. Null, and nothing written, if there is no record.
  update(id: string, change: (run: RunRecord) => RunRecord | void): Promise<RunRecord | null>;
  // Deletes the record. True if there was one.
  remove(id: string): Promise<boolean>;
}

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// A record's owner, if it has a well-formed one. Older records have none.
export function ownerOf(run: { owner?: unknown } | null | undefined): RunOwner | null {
  const o: any = run?.owner;
  if (!o || !Number.isInteger(o.pid) || !Number.isInteger(o.port) || !Number.isFinite(o.checkedAt)) return null;
  return { pid: o.pid, port: o.port, checkedAt: o.checkedAt, ...(typeof o.serverId === "string" && o.serverId ? { serverId: o.serverId } : {}) };
}

// How often a live run's owner checks in, and how old a check-in may be before
// the owner counts as dead.
export const CHECK_IN_MS = 5_000;
export const DEAD_AFTER_MS = 20_000;

// The one place that decides whether a record's owner is alive: its last
// check-in is under DEAD_AFTER_MS old. A record with no owner (written by an
// older build) is not alive. `now` is passed in so tests can use a fake clock.
export function ownerAlive(run: { owner?: unknown } | null | undefined, now: number = Date.now()): boolean {
  const o = ownerOf(run);
  return !!o && now - o.checkedAt < DEAD_AFTER_MS;
}

// Who holds the floor of a session: the server whose run is live in it.
export interface Holder {
  port: number;
  serverId: string | null; // null for a record from an older build
  secondsSinceCheckIn: number;
  mine: boolean; // the record's serverId is this server's
}

// The holder of the record's run, or null when there is no record or its owner
// is dead. A record without a serverId is always another holder. `me` and `now`
// are passed in so tests can stand in for another server or a fake clock.
export function holderOf(
  run: { owner?: unknown } | null | undefined,
  now: number = Date.now(),
  me: string = serverId,
): Holder | null {
  const o = ownerOf(run);
  if (!o || !ownerAlive(run, now)) return null;
  return {
    port: o.port,
    serverId: o.serverId ?? null,
    secondsSinceCheckIn: Math.max(0, Math.round((now - o.checkedAt) / 1000)),
    mine: !!o.serverId && o.serverId === me,
  };
}

// The store backed by the session file.
export const fileRunStore: RunRecordStore = {
  async read(id) {
    const run = (await readSession(id))?.run;
    return run && typeof run === "object" ? copy(run) : null;
  },

  async write(id, run) {
    const session = await readSession(id);
    if (!session) throw new HttpError(404, "No such session");
    const out = copy(run);
    await writeSession(id, { ...session, run: out, revision: revisionOf(session) + 1 });
    return copy(out);
  },

  async update(id, change) {
    const session = await readSession(id);
    if (!session?.run) return null;
    const draft = copy(session.run);
    const out = copy(change(draft) ?? draft);
    await writeSession(id, { ...session, run: out, revision: revisionOf(session) + 1 });
    return copy(out);
  },

  async remove(id) {
    const session = await readSession(id);
    if (!session?.run) return false;
    const { run: _gone, ...rest } = session;
    await writeSession(id, { ...rest, revision: revisionOf(session) + 1 });
    return true;
  },
};
