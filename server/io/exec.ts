// The only place the server starts another program. Every run is written to the
// audit log as one 'io.exec' line: why it ran (a short constant the caller
// gives), what caused it (the chat, tool call or request, from auditContext),
// the program, its arguments, how it ended and how long it took.
//
// What never goes in the line: the environment, what the program printed
// (stdout, stderr) or what was sent to it. Arguments are logged because they
// are what was asked of the program; each is cut at ARG_MAX chars.
//
// The shape is `execFile(program, args, options, { why })`: the last argument
// is the audit's own, so a plugin can later reach this over a message channel
// with plain data and without ever holding child_process.

import { type ChildProcess, type ExecFileOptions, type SpawnOptions, execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { audit, noteSession } from "../audit.ts";
import { currentCause } from "../auditContext.ts";

const ARG_MAX = 300;

export interface Why {
  // A short constant naming the reason, e.g. 'git.status', 'file.pick'.
  why: string;
}

const clip = (s: string) => (s.length > ARG_MAX ? `${s.slice(0, ARG_MAX)}…` : s);

function causeFields() {
  const { session, call, request } = currentCause();
  if (session) noteSession(session);
  return {
    ...(session ? { session } : {}),
    ...(call ? { call } : {}),
    ...(request ? { request } : {}),
  };
}

function line(
  why: string,
  cause: ReturnType<typeof causeFields>,
  program: string,
  args: readonly string[],
  started: number,
  end: { exit: number | null; signal: string | null; timedOut: boolean; error?: string },
) {
  audit("io.exec", {
    why,
    ...cause,
    program,
    argv: args.map(clip),
    exit: end.exit,
    signal: end.signal,
    ms: Date.now() - started,
    timedOut: end.timedOut,
    ...(end.error ? { error: end.error } : {}),
  });
}

// Runs a program to the end and returns what it printed, like promisify(execFile).
// A failure rejects with node's own error (it carries stdout and stderr and the
// exit code), after the line is written. `options.timeout` is the time limit.
export function execFile(
  program: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, "encoding"> | undefined,
  { why }: Why,
): Promise<{ stdout: string; stderr: string }> {
  const cause = causeFields();
  const started = Date.now();
  return new Promise((resolve, reject) => {
    nodeExecFile(program, [...args], { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) {
        line(why, cause, program, args, started, { exit: 0, signal: null, timedOut: false });
        return resolve({ stdout, stderr });
      }
      const e = err as NodeJS.ErrnoException & { code?: number | string; signal?: string | null; killed?: boolean };
      const exit = typeof e.code === "number" ? e.code : null;
      line(why, cause, program, args, started, {
        exit,
        signal: e.signal ?? null,
        timedOut: Boolean(options?.timeout && e.killed && e.signal),
        ...(typeof e.code === "string" ? { error: e.code } : {}),
      });
      reject(Object.assign(err, { stdout, stderr }));
    });
  });
}

export interface SpawnWhy extends Why {
  // Kills the program (its whole process group when options.detached) after
  // this long, sets child.timedOut and emits 'timeout' on the child.
  timeoutMs?: number;
}

// stdout and stderr are typed as present because every caller asks for pipes.
export type AuditedChild = ChildProcess & { readonly timedOut: boolean; stdout: Readable; stderr: Readable };

// Starts a program and hands back the child, as spawn does. The line is
// written when it ends ('close') or fails to start ('error').
export function spawn(program: string, args: readonly string[], options: SpawnOptions, { why, timeoutMs }: SpawnWhy): AuditedChild {
  const cause = causeFields();
  const started = Date.now();
  const child = nodeSpawn(program, [...args], options) as ChildProcess;
  let timedOut = false;
  let written = false;
  const finish = (end: { exit: number | null; signal: string | null; error?: string }) => {
    if (written) return;
    written = true;
    clearTimeout(timer);
    line(why, cause, program, args, started, { ...end, timedOut });
  };
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          if (options.detached && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        child.emit("timeout");
      }, timeoutMs)
    : undefined;
  Object.defineProperty(child, "timedOut", { get: () => timedOut });
  child.on("error", (e: NodeJS.ErrnoException) => finish({ exit: null, signal: null, error: e.code ?? "error" }));
  child.on("close", (code, signal) => finish({ exit: code, signal }));
  return child as AuditedChild;
}
