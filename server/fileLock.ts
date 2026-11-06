// A lock file for the time one process is updating something on disk that
// another llama-mui process could update too (two servers on one
// ~/.llama-mui, say the dev server and the prod one). The lock is held only
// while the update runs, and a lock a crashed process left behind can't block
// anyone for long:
//
//  - a lock is taken by creating ~/.llama-mui/locks/<name>.lock, which fails if
//    it exists; it holds the owner's pid, a random token and the time;
//  - it's released by deleting it, but only if it still holds our token, so a
//    process whose lock was taken over never deletes the new owner's;
//  - a lock is stale, and taken over, when its owner's process is gone, or when
//    it's older than STALE_MS (an update takes milliseconds, so a lock that old
//    belongs to a stuck process or to a pid that was reused).
//
// When the lock stays busy for WAIT_MS the caller gets an error that says
// another process is updating, to try again. One gap: two processes that both
// find the same stale lock at the same instant can both take it over. It needs
// a crash and a collision together, and only ever means the old behavior.

import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HttpError } from "./http.ts";

export const STALE_MS = 30_000;
export const WAIT_MS = 3_000;
const RETRY_MS = 25;

export const locksDir = () => path.join(os.homedir(), ".llama-mui", "locks");

// Whether a process with this pid is running. EPERM means it is, but isn't
// ours to signal.
export function processAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

interface LockInfo {
  pid: number;
  token: string;
  at: number;
}

// Whether the lock file's content (or its absence of readable content) is one
// to take over. `mtime` is for a file that's empty or half written: its owner
// may be about to finish writing it, so it only counts as stale after a while.
export function isStale(info: Partial<LockInfo> | null, mtime: number, now = Date.now()): boolean {
  if (!info || typeof info.pid !== "number" || typeof info.at !== "number") return now - mtime > STALE_MS;
  if (now - info.at > STALE_MS) return true;
  return !processAlive(info.pid);
}

async function readLock(file: string): Promise<{ info: Partial<LockInfo> | null; mtime: number } | null> {
  try {
    const [text, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    try {
      return { info: JSON.parse(text), mtime: st.mtimeMs };
    } catch {
      return { info: null, mtime: st.mtimeMs };
    }
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs `fn` holding the lock `name` (plain letters, digits and dashes).
export async function withFileLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(name)) throw new HttpError(400, "Bad lock name");
  await mkdir(locksDir(), { recursive: true, mode: 0o700 });
  const file = path.join(locksDir(), `${name}.lock`);
  const token = randomBytes(8).toString("hex");
  const mine: LockInfo = { pid: process.pid, token, at: Date.now() };
  const deadline = Date.now() + WAIT_MS;

  for (;;) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(mine));
      } finally {
        await handle.close();
      }
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    const held = await readLock(file);
    if (held && isStale(held.info, held.mtime)) {
      await rm(file, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new HttpError(503, "Another llama-mui process is updating this session right now. Try again in a moment.", {
        reason: "busy",
      });
    }
    await sleep(RETRY_MS);
  }

  try {
    return await fn();
  } finally {
    const now = await readLock(file).catch(() => null);
    if (now?.info?.token === token) await rm(file, { force: true });
  }
}
