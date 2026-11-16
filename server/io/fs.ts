// The only place the server changes a file or folder (apart from the audit and
// log writers and the lock file, which are the base layer; see the guard
// test). Every change is written to the audit log as one 'io.fs' line: why it
// was made (a short constant the caller gives), what caused it (from
// auditContext), the operation, the path and, for a write, how many bytes.
//
// What never goes in the line: what was written. A failed change is logged
// too, with the error's code, and then thrown again as it was.
//
// The shape is `write(path, data, options, { why })`: the last argument is the
// audit's own, so a plugin can later reach this over a message channel with
// plain data and without ever holding node:fs.
//
// Reads are not wrapped: they change nothing.

import { appendFile, mkdir as nodeMkdir, mkdtemp, open, rename as nodeRename, rm, rmdir, writeFile } from "node:fs/promises";
import { mkdirSync as nodeMkdirSync, writeFileSync } from "node:fs";
import { dirname as dirnameOf } from "node:path";
import { audit, noteSession } from "../audit.ts";
import { currentCause, runWithoutCause } from "../auditContext.ts";
import { noteChangedFile } from "../changedFiles.ts";
import type { Why } from "./exec.ts";

export type FsOp = "write" | "append" | "rename" | "remove" | "mkdir";

export type WriteOptions = { mode?: number; flag?: string };
export type MkdirOptions = { recursive?: boolean; mode?: number };
export type RemoveOptions = { recursive?: boolean; force?: boolean };

const sizeOf = (data: string | Uint8Array) => (typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);

function errorName(e: any): string {
  return typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "error";
}

function record(why: string, op: FsOp, path: string, extra: { to?: string; bytes?: number }, error?: unknown) {
  const { session, call, request } = currentCause();
  if (session) noteSession(session);
  audit("io.fs", {
    why,
    ...(session ? { session } : {}),
    ...(call ? { call } : {}),
    ...(request ? { request } : {}),
    op,
    path,
    ...(extra.to !== undefined ? { to: extra.to } : {}),
    ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
    ...(error !== undefined ? { error: errorName(error) } : {}),
  });
  // A separate call from the audit line: the run record keeps its own list.
  if (session && error === undefined) noteChangedFile(session, path);
}

// Runs the change, then writes its one line, whether it worked or not.
async function run<T>(why: string, op: FsOp, path: string, extra: { to?: string; bytes?: number }, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    record(why, op, path, extra);
    return result;
  } catch (e) {
    record(why, op, path, extra, e);
    throw e;
  }
}

function runSync<T>(why: string, op: FsOp, path: string, extra: { bytes?: number }, fn: () => T): T {
  try {
    const result = fn();
    record(why, op, path, extra);
    return result;
  } catch (e) {
    record(why, op, path, extra, e);
    throw e;
  }
}

// Writes a file, replacing it (or with flag "wx", failing if it exists).
export function write(path: string, data: string | Uint8Array, options: WriteOptions | undefined, { why }: Why): Promise<void> {
  return run(why, "write", path, { bytes: sizeOf(data) }, () => writeFile(path, data, options));
}

// The same, waiting for the disk (for startup code that cannot be async).
export function writeSync(path: string, data: string | Uint8Array, options: WriteOptions | undefined, { why }: Why): void {
  return runSync(why, "write", path, { bytes: sizeOf(data) }, () => writeFileSync(path, data, options));
}

// Adds to the end of a file, making it if it is missing.
export function append(path: string, data: string | Uint8Array, options: WriteOptions | undefined, { why }: Why): Promise<void> {
  return run(why, "append", path, { bytes: sizeOf(data) }, () => appendFile(path, data, options));
}

// Moves a file or folder. The line's path is where it was; `to` is where it went.
export function rename(from: string, to: string, { why }: Why): Promise<void> {
  return run(why, "rename", from, { to }, () => nodeRename(from, to));
}

// Deletes a file, or a folder with recursive.
export function remove(path: string, options: RemoveOptions | undefined, { why }: Why): Promise<void> {
  return run(why, "remove", path, {}, () => rm(path, options));
}

// Deletes a folder only if it is empty (fails otherwise). Logged as a 'remove'.
export function removeEmptyDir(path: string, { why }: Why): Promise<void> {
  return run(why, "remove", path, {}, () => rmdir(path));
}

// Makes a folder.
export function mkdir(path: string, options: MkdirOptions | undefined, { why }: Why): Promise<void> {
  return run(why, "mkdir", path, {}, async () => {
    await nodeMkdir(path, options);
  });
}

export function mkdirSync(path: string, options: MkdirOptions | undefined, { why }: Why): void {
  runSync(why, "mkdir", path, {}, () => {
    nodeMkdirSync(path, options);
  });
}

// ---- Batched mode -------------------------------------------------------
// For state that is saved over and over (a session's file at every step, the
// usage log at every turn): one line each would drown the audit log. These
// write the file exactly as the plain ones do, but only count the write. Once
// a minute, and when the process exits, each path that was written gets one
// 'io.fs.batch' line: why, the path, how many writes and how many bytes in all.
// So no write goes uncounted. Counts are kept per path and per chat, so a line
// carries the chat's id (from the cause, or from a sessions/<id>/ path). A failed write is not batched: it
// leaves an 'io.fs' line with its error at once, like any other.

export const BATCH_MS = 60_000;

type Tally = { why: string; path: string; session?: string; count: number; bytes: number };
const tallies = new Map<string, Tally>();
let timer: ReturnType<typeof setTimeout> | undefined;
let exitHooked = false;

// Writes one 'io.fs.batch' line for every path and chat counted so far, and
// starts over. A file several chats write (the usage log) gets one line each.
export function flushBatches(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const lines = [...tallies.values()];
  tallies.clear();
  // Outside any cause: a timer started inside a chat must not stamp the lines.
  runWithoutCause(() => {
    for (const t of lines) {
      audit("io.fs.batch", { why: t.why, ...(t.session ? { session: t.session } : {}), path: t.path, count: t.count, bytes: t.bytes });
    }
  });
}

// The chat a write belongs to: the cause's, else the id in a sessions/<id>/ path.
function sessionOf(path: string): string | undefined {
  return currentCause().session ?? /[\\/]sessions[\\/]([^\\/]+)[\\/]/.exec(path)?.[1];
}

function tally(why: string, path: string, bytes: number) {
  const session = sessionOf(path);
  const key = `${why}\0${session ?? ""}\0${path}`;
  const t = tallies.get(key);
  if (t) {
    t.count += 1;
    t.bytes += bytes;
  } else tallies.set(key, { why, path, session, count: 1, bytes });
  if (!timer) {
    timer = setTimeout(flushBatches, BATCH_MS);
    timer.unref?.();
  }
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", flushBatches);
  }
}

// Runs a batched write; on failure logs the error line now and throws it again.
async function batched(why: string, path: string, bytes: number, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    record(why, "write", path, { bytes }, e);
    throw e;
  }
  tally(why, path, bytes);
}

// `sync`: wait until the disk has the data (the file, then its folder after the
// rename) before resolving, so the write survives a crash or power loss. Slower
// (about 9 ms on a 1.7 MB chat), so only for the writes that must outlive one.
export type BatchedOptions = { mode?: number; dirMode?: number; sync?: boolean };

// Writes `file` through a temporary file and a rename, so a crash mid-write
// cannot leave it cut short; makes its folder first. Counts as one write of `file`.
export function writeAtomicBatched(file: string, data: string, options: BatchedOptions, { why }: Why): Promise<void> {
  return batched(why, file, sizeOf(data), async () => {
    await nodeMkdir(dirnameOf(file), { recursive: true, mode: options.dirMode });
    const tmp = `${file}.tmp`;
    if (options.sync) {
      const handle = await open(tmp, "w", options.mode);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await writeFile(tmp, data, { mode: options.mode });
    }
    await nodeRename(tmp, file);
    if (options.sync) {
      // The rename lives in the folder: it needs its own sync.
      const dir = await open(dirnameOf(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  });
}

// Adds to the end of `file`, making its folder first. Counts as one write.
export function appendBatched(file: string, data: string, options: BatchedOptions, { why }: Why): Promise<void> {
  return batched(why, file, sizeOf(data), async () => {
    await nodeMkdir(dirnameOf(file), { recursive: true, mode: options.dirMode });
    await appendFile(file, data, { mode: options.mode });
  });
}

// Makes a new folder with a unique name starting with `prefix` and returns its
// path. The line is a 'mkdir' of the path that was made (or of the prefix, if it failed).
export async function makeTempDir(prefix: string, { why }: Why): Promise<string> {
  let made: string;
  try {
    made = await mkdtemp(prefix);
  } catch (e) {
    record(why, "mkdir", prefix, {}, e);
    throw e;
  }
  record(why, "mkdir", made, {});
  return made;
}
