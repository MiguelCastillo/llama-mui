// run_command: runs a shell command the model suggests, once the user has
// approved that exact command and folder. It runs as the user, with their
// login PATH, network and credentials, which is the point: the model can't reach
// GitHub, but `git push` run here can.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolveAllowed } from "./disk.ts";
import { log } from "./log.ts";
import { type ToolContext, ToolError, type ToolSpec, fn, reasonOf, requireApproval } from "./toolkit.ts";

const TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_CHARS = 50_000;

// The folder to run in: the one the model named, or else the chat's working
// directory. An attached folder is never the default.
async function workingDir(ctx: ToolContext, raw: unknown): Promise<string> {
  if (raw) {
    const dir = await resolveAllowed(ctx, raw);
    if (!(await stat(dir)).isDirectory()) throw new ToolError(`${dir} is a file; cwd must be a folder`);
    return dir;
  }
  if (!ctx.workingDir) throw new ToolError("There's no working directory; pass cwd, the folder to run in");
  return ctx.workingDir;
}

const SHELL = process.env.SHELL || "/bin/zsh";

// How long the login profile gets to run before its environment is given up on.
const LOGIN_ENV_TIMEOUT_MS = 5000;

// Reads the environment of the user's login shell (PATH with Homebrew and the
// like). The shell runs detached, in a session of its own with no terminal, so
// nothing in the profile can stop to ask for input: a prompt that opens
// /dev/tty (ssh-add asking for a passphrase) fails at once instead of waiting
// on the terminal the server was started from, and ssh-add is told not to show
// a window instead. A profile that still takes longer than the time limit, or
// fails, is killed with all it started, and the server's own environment is
// used: a command then can't find a tool at worst, and nothing hangs.
export function readLoginEnv(shell: string, timeoutMs: number): Promise<{ env: NodeJS.ProcessEnv; fallback: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (env: NodeJS.ProcessEnv, fallback: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ env, fallback });
    };
    const child = spawn(shell, ["-lc", "env -0"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
      done(process.env, `the login profile took longer than ${timeoutMs / 1000} seconds`);
    }, timeoutMs);
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", (e) => done(process.env, `the login shell didn't start: ${e.message}`));
    child.on("close", (code) => {
      if (code !== 0) return done(process.env, `the login shell exited with code ${code}`);
      const env: NodeJS.ProcessEnv = {};
      for (const entry of out.split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      done(env, null);
    });
  });
}

// Read once per server, starting when the server does (prepareLoginEnv), so a
// slow or broken profile shows up in the log at startup rather than in a chat.
// Commands then run with it in a plain shell, so whatever the login profile
// prints (ssh-add's "Identity added", say) doesn't land in every result.
let loginEnvPromise: Promise<NodeJS.ProcessEnv> | null = null;
function loginEnv(): Promise<NodeJS.ProcessEnv> {
  if (!loginEnvPromise) {
    const started = Date.now();
    loginEnvPromise = readLoginEnv(SHELL, LOGIN_ENV_TIMEOUT_MS).then(({ env, fallback }) => {
      if (fallback) log("terminal.loginEnvFallback", { reason: fallback, ms: Date.now() - started });
      else log("terminal.loginEnv", { ms: Date.now() - started });
      return env;
    });
  }
  return loginEnvPromise;
}

// Called once the server starts (see whenServing in plugin.ts): reads the
// login environment in the background. A command that comes before it is done
// waits for it, at most the time limit.
export function prepareLoginEnv(): void {
  void loginEnv();
}

// The message when the caller gave up on a command (Stop everything).
const STOPPED = "Stopped by the user before it finished";

// stdin is closed and git is told not to prompt, so a command waiting for
// input fails instead of hanging until the timeout. An aborted signal stops
// it, and everything it started, at once, including while the login
// environment is still being read.
export async function exec(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new ToolError(STOPPED);
  const baseEnv = await new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
    const onAbort = () => reject(new ToolError(STOPPED));
    signal?.addEventListener("abort", onAbort, { once: true });
    loginEnv().then((env) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(env);
    });
  });
  if (signal?.aborted) throw new ToolError(STOPPED);
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  return new Promise((resolve, reject) => {
    const child = spawn(SHELL, ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      // Own process group, so the timeout kills what the command started too.
      detached: true,
    });
    let output = "";
    let cut = false;
    const take = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
      else cut = true;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, TIMEOUT_MS);
    signal?.addEventListener("abort", killGroup, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", killGroup);
      reject(e);
    });
    child.on("close", (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", killGroup);
      if (signal?.aborted) return reject(new ToolError(STOPPED));
      const body = output.length > MAX_OUTPUT_CHARS || cut ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (output cut)` : output;
      const status = timedOut
        ? `killed after ${TIMEOUT_MS / 1000} seconds`
        : killedBy
          ? `killed by ${killedBy}`
          : `exit code ${code}`;
      resolve(`$ ${command}\n${body.trimEnd() || "(no output)"}\n[${status}]`);
    });
  });
}

const runCommand: ToolSpec = {
  name: "run_command",
  group: "terminal",
  label: "Run commands",
  summary: `Run a shell command after you approve it, for up to ${TIMEOUT_MS / 60000} minutes.`,
  definition: fn(
    "run_command",
    "Run a shell command on the user's computer, for example git, gh, npm or ls. The user sees the command and " +
      "approves it before it runs. It runs non-interactively (no input, no password prompts) and is stopped " +
      `after ${TIMEOUT_MS / 60000} minutes. Returns the combined output and exit code.`,
    {
      type: "object",
      properties: {
        command: { type: "string", description: "The command, as you'd type it in a terminal." },
        cwd: {
          type: "string",
          description: "Folder to run in, absolute or relative to the working directory. Defaults to the working directory.",
        },
        reason: {
          type: "string",
          description:
            "One plain sentence on why this is needed, in terms of what the user asked for. Don't repeat the command.",
        },
        read_only: {
          type: "boolean",
          description:
            "True only if the command just looks and changes nothing (git log, git status, ls, grep, cat). " +
            "False if it changes files, branches, packages or the network.",
        },
      },
      required: ["command"],
    },
  ),
  async run(ctx, args) {
    const command = String(args.command ?? "").trim();
    if (!command) throw new ToolError("command is required");
    const cwd = await workingDir(ctx, args.cwd);
    const reason = reasonOf(args);
    // Only a real boolean counts; anything else leaves the key out, so the same
    // arguments always give the same Approval.
    const readOnly = typeof args.read_only === "boolean" ? args.read_only : undefined;
    requireApproval(ctx, {
      type: "command",
      command,
      cwd,
      ...(reason ? { reason } : {}),
      ...(readOnly === undefined ? {} : { readOnly }),
    });
    return exec(command, cwd, ctx.signal);
  },
};

export const TERMINAL_TOOLS = [runCommand];
