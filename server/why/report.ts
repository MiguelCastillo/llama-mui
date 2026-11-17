// Builds the plain-text report of the `why` command (see docs/guide.md).
//
// Read only, and not recovery code: recovery must never import this file
// (it pulls in the timeline, which reads the audit). It runs the three
// sources (chat, timeline, servers) and prints five sections: Chat, Run
// record, Timeline, Servers, Missing. It never prints message text.

import { defaultRoot, findChat, type ChatFacts } from "./chat.ts";
import { collectServers, describeServer, realDeps, type Deps } from "./servers.ts";
import { collectTimeline, type Window } from "./timeline.ts";

const WINDOW_MS = 5 * 60 * 1000;

// "10:48" is local time today; if that is still ahead of `now`, yesterday.
export function windowAt(hhmm: string, now: number): Window | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let t = d.getTime();
  if (t > now + WINDOW_MS) t -= 24 * 3600 * 1000;
  return { from: t - WINDOW_MS, to: t + WINDOW_MS };
}

const iso = (t: number | null) => (t === null ? "unknown" : new Date(t).toISOString());

function chatSection(c: ChatFacts): string[] {
  const out = ["Chat", `  title: ${c.title}`, `  id: ${c.id}`, `  last saved: ${iso(c.updatedAt)}`];
  if (c.thread) out.push(`  thread of: ${c.thread.parentTitle ?? "(unknown)"} (${c.thread.parentId}), outcome ${c.thread.outcome ?? "unknown"}`);
  else if (c.parentId) out.push(`  parent: ${c.parentId} (its saved threads list does not name this chat)`);
  else out.push("  parent: none");
  for (const t of c.threads) out.push(`  started thread: ${t.sessionId}, outcome ${t.outcome ?? "unknown"}`);
  out.push(`  ended by (saved apart from the run): ${c.endedBy ?? "not set"}`);
  out.push(`  failed: ${c.failed ?? "no"}`);
  out.push(`  queue: ${c.queue.length} waiting, ${c.queue.paused ? "paused" : "not paused"}`);
  if (!c.plan) out.push("  plan: none");
  else {
    out.push("  plan:");
    for (const s of c.plan) out.push(`    ${s.n}. [${s.status}] ${s.summary ?? ""}${s.note ? ` (note: ${s.note})` : ""}`);
  }
  return out;
}

function runSection(c: ChatFacts, now: number): string[] {
  const r = c.run;
  if (!r) return ["Run record", "  none"];
  const o = r.owner;
  return [
    "Run record",
    `  kind: ${r.kind}  status: ${r.status ?? "unknown"}  ended by: ${r.endedBy ?? "not set"}`,
    `  started: ${iso(r.startedAt)}`,
    o
      ? `  owner: port=${o.port ?? "?"} serverId=${o.serverId ?? "?"} pid=${o.pid ?? "not recorded"}`
      : "  owner: none recorded",
    `  last check-in: ${r.checkInAgeSeconds === null ? "never" : `${r.checkInAgeSeconds} seconds before ${iso(now)}`}`,
  ];
}

export interface ReportOptions {
  root?: string;
  repo?: string;
  at?: string | null;
  now?: number;
  deps?: Deps;
}

// Returns the whole report as text. Always a string; the caller exits 0.
export async function buildReport(query: string, opts: ReportOptions = {}): Promise<string> {
  const root = opts.root ?? defaultRoot();
  const now = opts.now ?? Date.now();
  const found = await findChat(query, root, now);
  if (found.kind === "missing") return `No chat matches "${found.query}". Try the chat id or other words from its title.`;
  if (found.kind === "ambiguous") {
    const lines = [`${found.matches.length} chats match "${found.query}". Run it again with one id:`];
    for (const m of found.matches) lines.push(`  ${m.id}  ${m.title}  (last saved ${iso(m.updatedAt)})`);
    return lines.join("\n");
  }
  const chat = found.chat;
  const missing: string[] = [];

  let window: Window | null = null;
  if (opts.at) {
    window = windowAt(opts.at, now);
    if (!window) missing.push(`"${opts.at}" is not a time like 10:48, so the whole log is shown.`);
  }
  const tl = await collectTimeline(chat.id, { root, window });
  const sv = await collectServers({ root, repo: opts.repo, deps: opts.deps ?? realDeps });
  missing.push(...tl.missing, ...sv.missing);
  if (chat.run?.owner && chat.run.owner.serverId === null) missing.push("The run record has no server id, so the owner is known by port only.");
  if (chat.run?.owner && chat.run.owner.pid === null) missing.push("The run record has no process number for its owner.");

  const out: string[] = [...chatSection(chat), "", ...runSection(chat, now), "", `Timeline${window ? ` (within 5 minutes of ${opts.at})` : ""}`];
  if (tl.entries.length) for (const e of tl.entries) out.push(`  ${e.line}`);
  else out.push("  no lines found");
  out.push("", "Servers");
  if (sv.servers.length) for (const s of sv.servers) out.push(`  ${describeServer(s)}`);
  else out.push("  none found listening");
  out.push("", "Missing");
  const uniq = [...new Set(missing)];
  if (uniq.length) for (const m of uniq) out.push(`  - ${m}`);
  else out.push("  nothing");
  return out.join("\n");
}
