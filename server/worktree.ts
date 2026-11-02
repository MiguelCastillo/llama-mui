// Tools for working on a copy of a git repo without touching the user's own
// checkout: create_worktree makes a git worktree on a new branch inside the
// session's folder, remove_worktree takes it away. A session's worktrees/ folder
// is the one place the model may change files without asking (see
// inSessionWorktrees in disk.ts), so the user is asked once, here, when one is
// made or removed: that also changes the repo's own .git (a branch, and the
// worktree's entry).
//
// A worktree holds exactly the files git tracks at the commit it starts from.
// Ignored and untracked files (node_modules, usually .env) aren't in it, and a
// tracked secret is.

import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isInside, toAbsolute } from "./disk.ts";
import { sessionFolder } from "./sessions.ts";
import { type ToolContext, ToolError, type ToolSpec, fn, requireApproval } from "./toolkit.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (e: any) {
    throw new ToolError(String(e.stderr || e.message).trim().slice(0, 500));
  }
}

const gitOk = (cwd: string, ...args: string[]) =>
  git(cwd, ...args).then(
    () => true,
    () => false,
  );

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

// Becomes a folder name and a branch name, so only plain ones pass.
function checkName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name) || name.includes("..") || name.endsWith(".lock")) {
    throw new ToolError(`"${name}" isn't a usable worktree name: use letters, digits, ".", "_" and "-", up to 48`);
  }
  return name;
}

// The session's worktrees folder. The session has to have an id, which chat
// sends with every call.
function worktreesFolder(ctx: ToolContext): string {
  try {
    return path.join(sessionFolder(ctx.chatId), "worktrees");
  } catch {
    throw new ToolError("This session has no folder for worktrees");
  }
}

// Only repos inside the user's home, and never anything inside ~/.llama-mui
// (the app's own data: a branch of a session folder would reach its files).
async function checkRepoLocation(repo: string, given: string) {
  const home = await realpath(os.homedir());
  if (!isInside(repo, home)) throw new ToolError(`${given} is outside your home folder; worktrees are only made there`);
  if (isInside(repo, path.join(home, ".llama-mui"))) throw new ToolError(`${given} is part of this app's own data`);
}

const createWorktree: ToolSpec = {
  name: "create_worktree",
  group: "worktree",
  label: "Create worktrees",
  summary: "Make a git worktree of a repo on a new branch, to work in without prompts.",
  definition: fn(
    "create_worktree",
    "Make a git worktree of a repo in your home folder, on a new branch, in this session's own folder. The user " +
      "approves it once; after that you can read, write and run commands in it without being asked. " +
      "It holds only the files git tracks, so install dependencies before running tests. " +
      "Returns its path: use it as cwd for run_command.",
    {
      type: "object",
      properties: {
        repo: { type: "string", description: "Path of the repo, or a folder inside it. It must be in the user's home folder." },
        name: { type: "string", description: "Name for the worktree and its branch (llama/<name>). Defaults to the repo's folder name." },
        base: { type: "string", description: "Branch, tag or commit to start from. Defaults to the repo's current HEAD." },
      },
      required: ["repo"],
    },
  ),
  async run(ctx, args) {
    const { given, abs } = await toAbsolute(ctx.attachments, args.repo);
    const real = await realpath(abs).catch(() => {
      throw new ToolError(`${given} does not exist`);
    });
    await checkRepoLocation(real, given);
    const inside = (await stat(real)).isDirectory() ? real : path.dirname(real);
    // The repo's root, wherever in it the model pointed.
    const root = await git(inside, "rev-parse", "--show-toplevel").catch(() => {
      throw new ToolError(`${given} is not in a git repository`);
    });
    const top = await realpath(root);
    await checkRepoLocation(top, given);

    const name = checkName(String(args.name ?? path.basename(top)));
    const branch = `llama/${name}`;
    const target = path.join(worktreesFolder(ctx), name);
    if (await exists(target)) throw new ToolError(`${target} already exists; pick another name`);
    if (await gitOk(top, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) {
      throw new ToolError(`The branch ${branch} already exists in ${top}; pick another name`);
    }
    const base = args.base === undefined ? "HEAD" : String(args.base);
    if (base.startsWith("-") || !(await gitOk(top, "rev-parse", "--verify", "--quiet", `${base}^{commit}`))) {
      throw new ToolError(`${base} isn't a commit in ${top}`);
    }

    requireApproval(ctx, { type: "worktree", action: "create", repo: top, branch, path: target });
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await git(top, "worktree", "add", "-b", branch, target, base);
    return (
      `Created a worktree of ${top} at ${target} on a new branch ${branch}, from ${base}. ` +
      "It holds only the files git tracks, so install dependencies before running tests. " +
      `Use ${target} as cwd for run_command; files there need no approval.`
    );
  },
};

const removeWorktree: ToolSpec = {
  name: "remove_worktree",
  group: "worktree",
  label: "Remove worktrees",
  summary: "Remove one of this session's worktrees; its branch and commits are kept.",
  definition: fn(
    "remove_worktree",
    "Remove one of this session's worktrees. The user approves it. It's refused if the worktree has uncommitted " +
      "changes. The branch stays, with its commits.",
    {
      type: "object",
      properties: { name: { type: "string", description: "The worktree's name, as create_worktree returned it." } },
      required: ["name"],
    },
  ),
  async run(ctx, args) {
    const name = checkName(String(args.name ?? ""));
    const folder = worktreesFolder(ctx);
    const target = await realpath(path.join(folder, name)).catch(() => {
      throw new ToolError(`This session has no worktree named ${name}`);
    });
    // Through a symlink, the name could point anywhere.
    if (!isInside(target, await realpath(folder))) throw new ToolError(`${name} isn't one of this session's worktrees`);

    const common = await git(target, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (path.basename(common) !== ".git") throw new ToolError(`${name} isn't a worktree of an ordinary repo`);
    const repo = path.dirname(common);
    const branch = await git(target, "symbolic-ref", "--short", "HEAD").catch(() => "(detached)");
    const dirty = (await git(target, "status", "--porcelain")).split("\n").filter(Boolean);
    if (dirty.length) {
      throw new ToolError(`${name} has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}; commit or discard them first`);
    }

    requireApproval(ctx, { type: "worktree", action: "remove", repo, branch, path: target });
    await git(repo, "worktree", "remove", target);
    return `Removed the worktree ${target}. The branch ${branch} is kept in ${repo}, with its commits.`;
  },
};

export const WORKTREE_TOOLS = [createWorktree, removeWorktree];
