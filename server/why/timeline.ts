// The timeline for one chat, for the `why` command (see docs/guide.md).
//
// Read only, and not recovery code: recovery must never import this file,
// because it reads the audit. It collects the server-log and audit lines that
// carry the chat's id, plus the start, listening, shutdown and close lines of
// every process those lines came from, and returns them sorted by time.
//
// Each entry is one plain line: the time, the process, the event name and a
// few short plain fields from a fixed list. Arguments, paths, commands,
// prompts, reply text and anything long are never copied.
//
// `sources` is a named list. A new source (say, new run lifecycle lines) is
// added by putting one more entry in it; nothing else changes.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultRoot } from "./chat.ts";

export interface Entry {
  t: number; // ms since epoch
  pid: number | null;
  source: string; // name of the source it came from
  event: string;
  fields: string; // "key=value key=value", plain and short
  line: string; // the finished one-line text
}

export interface Window {
  from: number;
  to: number;
}

// What a source hands back: parsed lines that carry the chat id (`chat`), or
// that are server lifecycle lines of any process (`lifecycle`).
export interface Raw {
  chat: Record<string, unknown>[];
  lifecycle: Record<string, unknown>[];
}

export interface Source {
  name: string;
  read(root: string, chatId: string): Promise<Raw>;
}

// The only fields ever copied, and only when short plain scalars.
const FIELDS = ["mode", "reason", "kind", "request", "why", "op", "status", "step", "force", "port", "tool", "session"];
const VALUE_MAX = 60;
const LIFECYCLE = /^server\.(start|listening|shutdown|close|force-close)$/;

const plain = (v: unknown): string | null => {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string" && v.length <= VALUE_MAX && /^[\w.:@/-]+$/.test(v)) return v;
  return null;
};

function fieldsOf(rec: Record<string, unknown>, chatId: string): string {
  const out: string[] = [];
  for (const k of FIELDS) {
    const v = plain(rec[k]);
    if (v === null) continue;
    if (k === "session" && v === chatId) continue; // every line is about it
    out.push(`${k}=${v}`);
  }
  if (Array.isArray(rec.runs)) out.push(`runs=${rec.runs.length}`);
  return out.join(" ");
}

async function filesIn(dir: string, pattern: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => pattern.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function readLines(files: string[], chatId: string): Promise<Raw> {
  const raw: Raw = { chat: [], lifecycle: [] };
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const carries = line.includes(chatId);
      if (!carries && !line.includes('"event":"server.')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== "object" || typeof rec.event !== "string") continue;
      if (carries) raw.chat.push(rec);
      else if (LIFECYCLE.test(rec.event)) raw.lifecycle.push(rec);
    }
  }
  return raw;
}

export const sources: Source[] = [
  { name: "server-log", read: (root, id) => filesIn(path.join(root, "logs"), /^server-.*\.log$/).then((f) => readLines(f, id)) },
  { name: "audit", read: (root, id) => filesIn(path.join(root, "audit"), /\.log$/).then((f) => readLines(f, id)) },
];

export interface TimelineResult {
  entries: Entry[];
  pids: number[]; // processes that had a line about the chat
  missing: string[]; // what could not be found, in plain sentences
}

const toEntry = (rec: Record<string, unknown>, source: string, chatId: string): Entry | null => {
  const t = typeof rec.t === "string" ? Date.parse(rec.t) : NaN;
  if (!Number.isFinite(t)) return null;
  const pid = typeof rec.pid === "number" ? rec.pid : null;
  const event = String(rec.event);
  const fields = fieldsOf(rec, chatId);
  const time = new Date(t).toISOString();
  return { t, pid, source, event, fields, line: `${time} pid=${pid ?? "?"} ${event}${fields ? " " + fields : ""} [${source}]` };
};

// Folds a run of consecutive lines that say the same thing (same process,
// source, event and fields, ignoring the request id) into the first line plus
// a count and the time of the last one. Nothing is dropped: a repeated line is
// still listed once, and its count says how many there were.
export function collapse(sorted: Entry[]): Entry[] {
  const key = (e: Entry) => `${e.pid}|${e.source}|${e.event}|${e.fields.replace(/request=\S+ ?/, "").trim()}`;
  const out: Entry[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && key(sorted[j]) === key(sorted[i])) j++;
    const n = j - i;
    const first = sorted[i];
    if (n === 1) out.push(first);
    else out.push({ ...first, line: `${first.line} (${n} times, last at ${new Date(sorted[j - 1].t).toISOString()})` });
    i = j;
  }
  return out;
}

export async function collectTimeline(
  chatId: string,
  opts: { root?: string; window?: Window | null; sources?: Source[] } = {},
): Promise<TimelineResult> {
  const root = opts.root ?? defaultRoot();
  const win = opts.window ?? null;
  const list = opts.sources ?? sources;
  const inWindow = (t: number) => !win || (t >= win.from && t <= win.to);

  const chatEntries: Entry[] = [];
  const lifeEntries: Entry[] = [];
  for (const src of list) {
    const raw = await src.read(root, chatId);
    for (const r of raw.chat) {
      const e = toEntry(r, src.name, chatId);
      if (e) chatEntries.push(e);
    }
    for (const r of raw.lifecycle) {
      const e = toEntry(r, src.name, chatId);
      if (e) lifeEntries.push(e);
    }
  }

  // Processes involved: any that wrote a line about the chat inside the window.
  const pids = [...new Set(chatEntries.filter((e) => inWindow(e.t) && e.pid !== null).map((e) => e.pid as number))];
  const seen = new Set<string>();
  const sorted = [...chatEntries.filter((e) => inWindow(e.t)), ...lifeEntries.filter((e) => e.pid !== null && pids.includes(e.pid))]
    .filter((e) => {
      const key = `${e.t}|${e.pid}|${e.event}|${e.fields}|${e.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.t - b.t);
  const entries = collapse(sorted);

  const missing: string[] = [];
  if (!chatEntries.length) missing.push("No line in any server log or audit file carries this chat's id.");
  else if (!pids.length) missing.push("No line about this chat falls inside the time window.");
  const runEvents = chatEntries.filter((e) => /^run\.(start|started|end|ended|settle|settled)/.test(e.event));
  if (!runEvents.some((e) => /start/.test(e.event)) || !runEvents.some((e) => /end|settle/.test(e.event)))
    missing.push("No run started or ended events for this chat in any log.");
  if (!runEvents.some((e) => /settle/.test(e.event))) missing.push("No settle event for this chat in any log.");
  return { entries, pids, missing };
}
