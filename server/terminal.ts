// run_command: runs a shell command the model suggests, once the user has
// approved that exact command and folder. It runs as the user, with their
// login PATH, network and credentials, which is the point: the model can't reach
// GitHub, but `git push` run here can.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveAllowed } from "./disk.ts";
import { ToolError, type ToolSpec, fn, requireApproval } from "./toolkit.ts";

const TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_CHARS = 50_000;

// The folder to run in: the one the model named, or else the first attached
// folder (or the folder of an attached file).
async function workingDir(roots: string[], raw: unknown): Promise<string> {
  if (raw) {
    const dir = await resolveAllowed(roots, raw);
    if (!(await stat(dir)).isDirectory()) throw new ToolError(`${dir} is a file; cwd must be a folder`);
    return dir;
  }
  if (roots.length === 0) throw new ToolError("Nothing is attached to this chat; pass cwd, the folder to run in");
  return (await stat(roots[0])).isDirectory() ? roots[0] : path.dirname(roots[0]);
}

const SHELL = process.env.SHELL || "/bin/zsh";

// The environment of the user's login shell (PATH with Homebrew and the like),
// read once. Commands then run with it in a plain shell, so whatever the login
// profile prints (ssh-add's "Identity added", say) doesn't land in every result.
let loginEnvPromise: Promise<NodeJS.ProcessEnv> | null = null;
function loginEnv(): Promise<NodeJS.ProcessEnv> {
  loginEnvPromise ??= new Promise((resolve) => {
    const child = spawn(SHELL, ["-lc", "env -0"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => resolve(process.env));
    child.on("close", (code) => {
      if (code !== 0) return resolve(process.env);
      const env: NodeJS.ProcessEnv = {};
      for (const entry of out.split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      resolve(env);
    });
  });
  return loginEnvPromise;
}

// stdin is closed and git is told not to prompt, so a command waiting for
// input fails instead of hanging until the timeout.
export async function exec(command: string, cwd: string): Promise<string> {
  const env = { ...(await loginEnv()), GIT_TERMINAL_PROMPT: "0" };
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
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(-child.pid!, "SIGKILL");
    }, TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const body = output.length > MAX_OUTPUT_CHARS || cut ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (output cut)` : output;
      const status = timedOut
        ? `killed after ${TIMEOUT_MS / 1000} seconds`
        : signal
          ? `killed by ${signal}`
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
      },
      required: ["command"],
    },
  ),
  async run(ctx, args) {
    const command = String(args.command ?? "").trim();
    if (!command) throw new ToolError("command is required");
    const cwd = await workingDir(ctx.attachments, args.cwd);
    requireApproval(ctx, { type: "command", command, cwd });
    return exec(command, cwd);
  },
};

export const TERMINAL_TOOLS = [runCommand];
