// Holds the one child process that is the app, and restarts it only when asked.
// It never watches files and never restarts a crash by itself.
//
// Kept small on purpose: node builtins, the audited exec wrapper and the log
// only. It must not import app code, so it keeps working when the app is broken.

import type { Readable } from "node:stream";
import { execFile as auditedExecFile, spawn as auditedSpawn } from "../io/exec.ts";
import { log } from "../log.ts";

// What the supervisor needs from a child: the real one and a test's fake both fit.
export interface ManagedChild {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
}

export type SpawnFn = (program: string, args: readonly string[], options: Parameters<typeof auditedSpawn>[2]) => ManagedChild;
export type BuildFn = () => Promise<unknown>;

export type State = "running" | "stopped" | "restarting" | "crashed";

export interface Status {
  state: State;
  pid: number | null;
  startedAt: number | null;
  lastRestart: number | null;
  lastBuild: { ok: boolean; at: number } | null;
}

export type RestartResult = { ok: true } | { ok: false; reason: "already restarting" | "build failed"; error?: string };

export interface SupervisorOptions {
  program: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  spawn?: SpawnFn;
  // How the page is built before a restart. Default: `npx vite build`.
  build?: BuildFn;
  // After SIGTERM, how long to wait before SIGKILL.
  killAfterMs?: number;
}

const defaultSpawn: SpawnFn = (program, args, options) => auditedSpawn(program, args, options, { why: "manager.app" });
const defaultBuild = (cwd?: string) => auditedExecFile("npx", ["vite", "build"], { cwd, timeout: 5 * 60_000 }, { why: "manager.build" });

const short = (e: unknown) => String((e as { message?: string })?.message ?? e).split("\n")[0].slice(0, 200);

export class Supervisor {
  private child: ManagedChild | null = null;
  private state: State = "stopped";
  private startedAt: number | null = null;
  private lastRestart: number | null = null;
  private lastBuild: { ok: boolean; at: number } | null = null;
  private exited: Promise<void> | null = null;
  private stopping = false;
  private restarting = false;
  private readonly spawnFn: SpawnFn;
  private readonly buildFn: BuildFn;
  private readonly killAfterMs: number;

  private readonly opts: SupervisorOptions;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.buildFn = opts.build ?? (() => defaultBuild(opts.cwd));
    this.killAfterMs = opts.killAfterMs ?? 15_000;
  }

  status(): Status {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      lastRestart: this.lastRestart,
      lastBuild: this.lastBuild,
    };
  }

  // Spawns the app. Does nothing if one is already running.
  start(): void {
    if (this.child) return;
    const child = this.spawnFn(this.opts.program, this.opts.args, {
      env: this.opts.env ?? process.env,
      cwd: this.opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.stopping = false;
    this.startedAt = Date.now();
    child.stdout?.pipe(process.stdout, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });
    this.exited = new Promise<void>((resolve) => {
      let done = false;
      const gone = (how: string, code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        if (this.child === child) {
          this.child = null;
          if (!this.stopping) {
            this.state = "crashed";
            log("manager.crashed", { pid: child.pid, exit: code, signal, how });
          }
        }
        resolve();
      };
      child.once("exit", (code, signal) => gone("exit", code, signal));
      child.once("error", () => gone("error", null, null));
    });
    if (this.state !== "restarting") this.state = "running";
    log("manager.start", { pid: child.pid });
  }

  // SIGTERM, wait for the exit, SIGKILL after killAfterMs.
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || !this.exited) {
      if (this.state !== "restarting") this.state = "stopped";
      return;
    }
    this.stopping = true;
    const exited = this.exited;
    let how = "exited";
    child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((r) => {
      timer = setTimeout(() => r("late"), this.killAfterMs);
    });
    if ((await Promise.race([exited.then(() => "done" as const), late])) === "late") {
      how = "killed";
      child.kill("SIGKILL");
      await exited;
    }
    clearTimeout(timer);
    this.child = null;
    this.startedAt = null;
    if (this.state !== "restarting") this.state = "stopped";
    log("manager.stop", { pid: child.pid, how });
  }

  // Builds (if asked), then stops and starts. A failed build leaves the running app alone.
  async restart({ build }: { build: boolean }): Promise<RestartResult> {
    if (this.restarting) return { ok: false, reason: "already restarting" };
    this.restarting = true;
    const before = this.state;
    try {
      if (build) {
        try {
          await this.buildFn();
          this.lastBuild = { ok: true, at: Date.now() };
        } catch (e) {
          this.lastBuild = { ok: false, at: Date.now() };
          log("manager.build-failed", { error: short(e) });
          return { ok: false, reason: "build failed", error: short(e) };
        }
      }
      this.state = "restarting";
      await this.stop();
      this.start();
      this.state = "running";
      this.lastRestart = Date.now();
      return { ok: true };
    } catch (e) {
      this.state = before === "running" ? "stopped" : before;
      throw e;
    } finally {
      this.restarting = false;
    }
  }
}
