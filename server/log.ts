// The server's log: one JSON object per line in ~/.llama-mui/logs/server-<day>.log,
// for finding out afterwards what happened between llama-mui and a model
// server (a reply cut off, a server that stopped answering, llama-mui itself
// restarting). A line is `{ "t": ISO time, "pid", "event", ...fields }`.
//
// What goes in: when requests to a model server start and how they ended, when
// this server starts, stops or crashes, and whether a model server answers.
// What never goes in: an API key, a header, a prompt or a reply. Callers pass
// only plain facts (a path, a status, a duration, an error's code); `log` has
// no way to know a secret from anything else, so the callers are the check.
//
// Logging must never break the server: every failure here is swallowed.

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const KEEP_DAYS = 14;

// A function, not a constant, so tests that point os.homedir elsewhere (and a
// day that turns over) are respected.
export const logsDir = () => path.join(os.homedir(), ".llama-mui", "logs");
const fileFor = (d: Date) => path.join(logsDir(), `server-${d.toISOString().slice(0, 10)}.log`);

// Where today's log is and how to follow it, for the server to print when it
// starts so nobody has to dig for it. Days are UTC, as in the file name.
export function logHint(now = new Date()): string {
  const file = fileFor(now);
  const quoted = /[^\w./-]/.test(file) ? `'${file}'` : file;
  return `llama-mui log: ${file}\n  follow it with: tail -f ${quoted}`;
}

let ensured: string | null = null;

export function log(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const now = new Date();
    const dir = logsDir();
    if (ensured !== dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      ensured = dir;
    }
    appendFileSync(fileFor(now), JSON.stringify({ t: now.toISOString(), pid: process.pid, event, ...fields }) + "\n", { mode: 0o600 });
  } catch {
    // A full disk or a read-only home is not worth stopping a reply for.
  }
}

// What an error says, as plain fields: its name and message, and the code or
// message of its cause (Node's fetch puts the real reason there: "terminated"
// is the error, "other side closed" with UND_ERR_SOCKET is the cause).
export function errorFields(e: any): Record<string, unknown> {
  const cause = e?.cause;
  return {
    error: String(e?.message ?? e),
    ...(e?.name && e.name !== "Error" ? { errorName: e.name } : {}),
    ...(e?.code ? { code: e.code } : {}),
    ...(cause ? { cause: cause.code ?? String(cause.message ?? cause), ...(cause.code && cause.message ? { causeMessage: String(cause.message) } : {}) } : {}),
  };
}

// Removes logs older than KEEP_DAYS. Called once when a server starts.
export function pruneLogs(now = Date.now()): void {
  try {
    const cutoff = new Date(now - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const name of readdirSync(logsDir())) {
      const m = /^server-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (m && m[1] < cutoff) unlinkSync(path.join(logsDir(), name));
    }
  } catch {
    // Nothing to prune, or can't.
  }
}

let installed = false;

// Logs the ways this process can end without anyone asking: a crash, a promise
// nobody caught, and any exit. Once per process, however many servers start in
// it (Vite restarts its server in the same process). `uncaughtException` logs
// and then exits the way Node would have: the handler replaces that default.
export function logProcessEnd(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (e) => {
    log("process.crash", errorFields(e));
    console.error(e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    // Node prints these and, by default, exits; keep that, but leave a line first.
    log("process.unhandled-rejection", errorFields(e));
    throw e;
  });
  process.on("exit", (code) => log("process.exit", { code }));
}
