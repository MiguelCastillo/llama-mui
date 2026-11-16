// Hearing about changes another server wrote.
//
// Two servers (the built app and the dev one) share one sessions folder, but
// each only publishes events for what it did itself. This watches the folder
// for session files that changed behind its back and publishes what changed to
// its own pages, in the same events a local change makes: `saved` (the list
// row), `status` (the run record changed), `ask`, and `session` (a patch of the
// chat, for a session that has a run record). The file system's change
// notifications make it quick; a slow poll that looks at every file's size and
// time is the backstop for the ones that get lost.
//
// Only the session files are read, never the audit. A change this process made
// is told apart by its revision: the hub's own `saved` events carry it, so
// they are not published twice. A session this process is running is left to
// the hub.

import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "./disk.ts";
import { liveRun, publish, subscribe } from "./runHub.ts";
import { ownerAlive } from "./runRecord.ts";
import { copyForEvents, diffSession } from "./sessionPatch.ts";
import { readSession, revisionOf, summaryOf } from "./sessionFile.ts";

export const WATCH_POLL_MS = 3_000;
const DEBOUNCE_MS = 50;

interface Known {
  revision: number;
  summary: string; // the list row, as text
  body: string; // the session without its run record and revision, as text
  run: string; // the run record without the check-in time, as text
  ask: string;
  copy?: any; // for a session with a run record: what the last patch was made from
}

const runKey = (run: any) => {
  if (!run) return "";
  const { owner, ...rest } = run;
  return JSON.stringify({ ...rest, owner: owner ? { pid: owner.pid, port: owner.port } : null });
};

export function startSessionWatch(opts: { pollMs?: number; debounceMs?: number } = {}): () => void {
  const pollMs = opts.pollMs ?? WATCH_POLL_MS;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const known = new Map<string, Known>();
  const stamps = new Map<string, string>(); // id -> "mtime:size" of its file
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let ready = false;

  // What this process published itself is already known to its pages.
  const unsubscribe = subscribe((e) => {
    if (e.type !== "saved") return;
    const k = known.get(e.id);
    const rev = Number(e.data.revision);
    if (k && rev > k.revision) k.revision = rev;
  });

  async function check(id: string) {
    let session: any;
    try {
      session = await readSession(id);
    } catch {
      return; // half-written or unreadable: the next change or poll looks again
    }
    const before = known.get(id);
    if (!session) {
      if (before) {
        known.delete(id);
        stamps.delete(id);
        if (ready) publish({ type: "removed", id, data: {} });
      }
      return;
    }
    const revision = revisionOf(session);
    const { run, revision: _r, ...body } = session;
    const next: Known = {
      revision,
      summary: JSON.stringify(summaryOf(session)),
      body: JSON.stringify(body),
      run: runKey(run),
      ask: JSON.stringify(run?.ask ?? null),
    };
    if (run) next.copy = copyForEvents(session);
    known.set(id, next);
    if (!ready || liveRun(id)) return; // the first look, or this process's own run
    if (before && revision <= before.revision) return; // already told
    if (before && before.body === next.body && before.run === next.run && before.ask === next.ask) return; // only a check-in
    if (!before || before.summary !== next.summary || before.body !== next.body) {
      publish({ type: "saved", id, data: { summary: summaryOf(session), revision } });
    }
    if (before?.copy && run) {
      const patch = diffSession(before.copy, next.copy);
      if (patch) publish({ type: "session", id, data: { patch } });
    }
    if (!before || before.run !== next.run) {
      const alive = run && ownerAlive(run);
      publish({ type: "status", id, data: { run: alive ? run : null } });
    }
    if (!before || before.ask !== next.ask) publish({ type: "ask", id, data: { ask: run?.ask ?? null } });
  }

  const flush = () => {
    timer = undefined;
    const ids = [...pending];
    pending.clear();
    for (const id of ids) void check(id).catch(() => {});
  };
  const note = (id: string) => {
    if (stopped || !/^[a-z0-9-]{1,64}$/.test(id)) return;
    pending.add(id);
    timer ??= setTimeout(flush, debounceMs);
  };

  // Looks at every session file's time and size; a file that differs from the
  // last look is checked. Also finds files whose change notice was lost.
  async function scan() {
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    const seen = new Set<string>();
    for (const id of names) {
      if (!/^[a-z0-9-]{1,64}$/.test(id)) continue;
      const st = await stat(path.join(sessionsDir, id, "session.json")).catch(() => null);
      if (!st) continue;
      seen.add(id);
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamps.get(id) !== stamp) {
        stamps.set(id, stamp);
        await check(id);
      }
    }
    for (const id of [...known.keys()]) if (!seen.has(id)) await check(id);
  }

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(sessionsDir, { recursive: true }, (_event, file) => {
      const id = file ? String(file).split(path.sep)[0] : "";
      if (id) note(id);
    });
    watcher.on("error", () => {}); // the poll carries on
    watcher.unref();
  } catch {
    // No folder yet, or no recursive watching here: the poll covers it.
  }

  void scan().then(() => void (ready = true));
  const poll = setInterval(() => {
    if (ready) void scan().catch(() => {});
  }, pollMs);
  poll.unref?.();

  return () => {
    stopped = true;
    clearInterval(poll);
    if (timer) clearTimeout(timer);
    watcher?.close();
    unsubscribe();
  };
}
