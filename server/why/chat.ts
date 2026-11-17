// The saved facts about one chat, for the `why` command (see docs/guide.md).
//
// Read only: this file reads session.json files and writes nothing. It is not
// recovery code. Recovery (restart.ts, runRecord.ts, settleStale in runHub.ts)
// must never depend on it, and it takes its facts from the saved session only.
//
// It never returns message text, drafts, prompts or queued messages. What it
// does return: the title, ids, each plan step's status and note, how the last
// run ended, the queue's size and pause, and the run record's owner.
//
// `root` is the llama-mui data folder (default ~/.llama-mui), so a test can
// point it at a temp folder.

import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const defaultRoot = () => path.join(os.homedir(), ".llama-mui");

const NOTE_MAX = 300;
const clip = (s: unknown): string | null => {
  if (typeof s !== "string" || !s) return null;
  return s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX)}…` : s;
};
const str = (s: unknown): string | null => (typeof s === "string" && s ? s : null);

export interface StepFacts {
  n: number; // 1-based position
  status: string;
  summary: string | null;
  note: string | null;
}

export interface RunFacts {
  status: string | null;
  kind: "turn" | "plan";
  startedAt: number | null;
  endedBy: string | null;
  owner: { port: number | null; pid: number | null; serverId: string | null; checkedAt: number | null } | null;
  checkInAgeSeconds: number | null; // null when the owner has no check-in time
}

export interface ChatFacts {
  id: string;
  title: string; // the title the list shows: userName, else modelName, else title
  updatedAt: number | null;
  parentId: string | null;
  // Set when the parent's saved threads list names this chat.
  thread: { parentId: string; parentTitle: string | null; summary: string | null; outcome: string | null } | null;
  // Threads this chat started, from its own threads list.
  threads: { sessionId: string; summary: string | null; outcome: string | null }[];
  plan: StepFacts[] | null;
  endedBy: string | null; // saved apart from the run record
  failed: string | null;
  queue: { length: number; paused: boolean };
  run: RunFacts | null; // null: the session has no run record
}

export interface Match {
  id: string;
  title: string;
  updatedAt: number | null;
}

export type FindResult =
  | { kind: "found"; chat: ChatFacts }
  | { kind: "ambiguous"; query: string; matches: Match[] }
  | { kind: "missing"; query: string };

const displayTitle = (s: any): string => str(s?.userName) ?? str(s?.modelName) ?? str(s?.title) ?? "(untitled)";

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null; // missing or not valid: counts as not found
  }
}

const sessionPath = (root: string, id: string) => path.join(root, "sessions", id, "session.json");

// Folder names are session ids; only plain ones are looked at.
async function sessionIds(root: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, "sessions"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && /^[a-z0-9-]{1,64}$/.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

function runFacts(run: any, now: number): RunFacts | null {
  if (!run || typeof run !== "object") return null;
  const o = run.owner && typeof run.owner === "object" ? run.owner : null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const checkedAt = num(o?.checkedAt);
  return {
    status: str(run.status),
    kind: run.kind === "turn" ? "turn" : "plan",
    startedAt: num(run.startedAt),
    endedBy: str(run.endedBy),
    owner: o ? { port: num(o.port), pid: num(o.pid), serverId: str(o.serverId), checkedAt } : null,
    checkInAgeSeconds: checkedAt === null ? null : Math.max(0, Math.round((now - checkedAt) / 1000)),
  };
}

const outcomeOf = (t: any): string | null => str(t?.status); // "done" | "failed" | "unfinished"

async function factsOf(root: string, s: any, now: number): Promise<ChatFacts> {
  const id = String(s.id);
  let thread: ChatFacts["thread"] = null;
  const parentId = str(s.parentId);
  if (parentId && /^[a-z0-9-]{1,64}$/.test(parentId)) {
    const parent = await readJson(sessionPath(root, parentId));
    const link = Array.isArray(parent?.threads) ? parent.threads.find((t: any) => t?.sessionId === id) : null;
    if (link) thread = { parentId, parentTitle: parent ? displayTitle(parent) : null, summary: clip(link.summary), outcome: outcomeOf(link) };
  }
  return {
    id,
    title: displayTitle(s),
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : null,
    parentId,
    thread,
    threads: (Array.isArray(s.threads) ? s.threads : [])
      .filter((t: any) => typeof t?.sessionId === "string")
      .map((t: any) => ({ sessionId: t.sessionId, summary: clip(t.summary), outcome: outcomeOf(t) })),
    plan: Array.isArray(s.plan)
      ? s.plan.map((p: any, i: number) => ({
          n: i + 1,
          status: str(p?.status) ?? "unknown",
          summary: clip(p?.summary),
          note: clip(p?.note),
        }))
      : null,
    endedBy: str(s.endedBy),
    failed: clip(s.failed),
    queue: { length: Array.isArray(s.queue) ? s.queue.length : 0, paused: s.queuePaused === true },
    run: runFacts(s.run, now),
  };
}

// Finds one chat by its id (whole, or the start of it, six characters or more)
// or by title words: every word must appear in the title, the user's name or
// the model's name for it, in any case. Several chats match: they are listed,
// newest first, and nothing is chosen. `now` is passed in for tests.
export async function findChat(query: string, root: string = defaultRoot(), now: number = Date.now()): Promise<FindResult> {
  const q = query.trim();
  if (!q) return { kind: "missing", query };

  const exact = /^[a-z0-9-]{1,64}$/.test(q) ? await readJson(sessionPath(root, q)) : null;
  if (exact && String(exact.id) === q) return { kind: "found", chat: await factsOf(root, exact, now) };

  const words = q.toLowerCase().split(/\s+/);
  const prefix = /^[a-z0-9-]{6,}$/.test(q) ? q : null;
  const hits: any[] = [];
  for (const id of await sessionIds(root)) {
    const s = await readJson(sessionPath(root, id));
    if (!s || typeof s !== "object") continue;
    const sid = String(s.id ?? id);
    if (prefix && sid.startsWith(prefix)) {
      hits.push(s);
      continue;
    }
    const names = [s.title, s.userName, s.modelName].filter((x) => typeof x === "string").join(" ").toLowerCase();
    if (words.every((w) => names.includes(w))) hits.push(s);
  }
  if (!hits.length) return { kind: "missing", query };
  if (hits.length === 1) return { kind: "found", chat: await factsOf(root, hits[0], now) };
  hits.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  return {
    kind: "ambiguous",
    query,
    matches: hits.map((s) => ({ id: String(s.id), title: displayTitle(s), updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : null })),
  };
}
