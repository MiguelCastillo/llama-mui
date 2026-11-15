// The audit log: one JSON object per line in ~/.llama-mui/audit/audit-<day>.log,
// for finding out afterwards what the model and the pages did: which tools ran,
// what was approved and by whom, which requests were refused. A line is
// `{ "t": ISO time, "pid", "event", ...fields }`. Days are UTC, as in the file name.
//
// It is kept apart from the chat's saved file and from the server log (log.ts).
// A day's file is deleted once it is more than KEEP_DAYS days old (pruneAudit,
// run when the server starts and once a day); each deletion is itself
// recorded as an 'audit.pruned' line naming the files.
//
// What never goes in: a diff, a file's contents, a prompt, a reply, a request
// body, a header, a cookie or an API key. Callers pass only plain facts (a
// name, a size, a path, a status, a duration); `audit` can't tell a secret from
// anything else, so the callers are the check.
//
// Auditing must never break a run or a request: every failure here is swallowed.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { currentCause } from "./auditContext.ts";
import { sessionFile } from "./sessionFile.ts";

// A function, not a constant, so tests that point os.homedir elsewhere (and a
// day that turns over) are respected.
export const auditDir = () => path.join(os.homedir(), ".llama-mui", "audit");
const fileFor = (d: Date) => path.join(auditDir(), `audit-${d.toISOString().slice(0, 10)}.log`);

export function audit(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const now = new Date();
    // Created every time (cheap) so a folder removed while running comes back.
    mkdirSync(auditDir(), { recursive: true, mode: 0o700 });
    // What the current work belongs to (chat, tool call, request) goes on every
    // line, so one search of a chat id finds everything; the caller's own
    // fields win. `who` is left out: only the lines that name it carry it.
    const { session, call, request } = currentCause();
    const cause: Record<string, string> = {};
    if (session) cause.session = session;
    if (call) cause.call = call;
    if (request) cause.request = request;
    appendFileSync(fileFor(now), JSON.stringify({ t: now.toISOString(), pid: process.pid, event, ...cause, ...fields }) + "\n", { mode: 0o600 });
  } catch {
    // A full disk or a read-only home is not worth stopping a run for.
  }
}

// How long a day's file is kept.
export const KEEP_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Deletes audit-<day>.log files whose day is more than KEEP_DAYS before today
// (UTC), then writes one 'audit.pruned' line naming them. Returns the names.
export function pruneAudit(now: Date = new Date()): string[] {
  const removed: string[] = [];
  try {
    const cutoff = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
    for (const name of readdirSync(auditDir()).sort()) {
      const m = /^audit-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!m || m[1] >= cutoff) continue;
      try {
        unlinkSync(path.join(auditDir(), name));
        removed.push(name);
      } catch {
        // Left for the next day's pass.
      }
    }
  } catch {
    // No folder yet, or unreadable: nothing to prune.
  }
  if (removed.length) audit("audit.pruned", { files: removed, keepDays: KEEP_DAYS });
  return removed;
}

let pruneTimer: ReturnType<typeof setInterval> | undefined;

// Prunes now and then once every 24 hours. Calling it again (a dev server
// restarting in the same process) replaces the timer rather than adding one.
export function startAuditPruning(): void {
  pruneAudit();
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = setInterval(() => pruneAudit(), DAY_MS);
  pruneTimer.unref?.();
}

// What a session is called, from its saved file, read straight away so the
// line lands before the one that triggered it. Null when there is no file.
function sessionFacts(id: string): { session: string; title: string | null; workingDir: string | null; parent: string | null } | null {
  try {
    const s = JSON.parse(readFileSync(sessionFile(id), "utf8"));
    return {
      session: id,
      title: typeof s.title === "string" ? s.title : null,
      workingDir: typeof s.workingDir === "string" ? s.workingDir : null,
      parent: typeof s.parentId === "string" ? s.parentId : null,
    };
  } catch {
    return null;
  }
}

// Whether a chat with this id has a saved file (a thread's id is looked up by
// the part before the ":").
export function sessionExists(id: string): boolean {
  return sessionFacts(id.split(":")[0]) !== null;
}

const seen = new Set<string>();

// The first time a session appears in the audit in this process, writes a
// 'session.seen' line with its title, folder and parent, so a later line that
// only carries the id can still be traced once the session is renamed or
// deleted. Call it from every line that names a session. An id with a ":"
// (a thread's run) is looked up by the part before it. A session with no file
// is not marked, so it is noted once it exists.
export function noteSession(id: unknown): void {
  try {
    if (typeof id !== "string" || !id) return;
    const base = id.split(":")[0];
    if (seen.has(base)) return;
    const facts = sessionFacts(base);
    if (!facts) return;
    seen.add(base);
    audit("session.seen", facts);
  } catch {
    // Never in the way of the line that called it.
  }
}

// Writes 'session.deleted' (with the title, folder, parent and, for a delete of
// a family, every id removed with it) and must be called before the files go.
// Marks the session as seen, so it is not announced again.
export function auditSessionDeleted(id: string, family?: string[]): void {
  try {
    const facts = sessionFacts(id) ?? { session: id, title: null, workingDir: null, parent: null };
    audit("session.deleted", { ...facts, ...(family ? { family } : {}) });
    seen.add(id);
  } catch {
    // Same as audit.
  }
}

// For tests: forget which sessions have been announced.
export const resetSeenSessions = () => seen.clear();

// Who made a request: the remote address and the first 80 characters of the
// user-agent. Nothing else from the request.
export function whoOf(req: Pick<IncomingMessage, "socket" | "headers">): { address: string; agent: string } {
  const ua = req.headers?.["user-agent"];
  return {
    address: req.socket?.remoteAddress ?? "",
    agent: (Array.isArray(ua) ? ua[0] : ua ?? "").slice(0, 80),
  };
}
