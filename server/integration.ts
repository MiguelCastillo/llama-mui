// Merging one work stream into the main branch, first half: replay the branch's
// unmerged commits, one by one, on top of main's current tip inside a separate
// integration worktree kept outside the repo. The main folder (and any
// uncommitted files in it) is never touched here; main only moves later, on approval.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { audit } from "./audit.ts";
import { execFile } from "./io/exec.ts";
import { mkdir, remove, symlink } from "./io/fs.ts";
import { load } from "./store.ts";

export interface PrepareOptions {
  // Where integration worktrees live (default ~/.llama-mui/integration).
  integrationRoot?: string;
}

export interface PreparedMerge {
  conflict?: false;
  // Main branch name and the tip the replay was built on.
  base: string;
  baseTip: string;
  branch: string;
  integrationBranch: string;
  folder: string;
  // The main folder the attempt belongs to.
  repo: string;
  replayed: number;
}

export interface MergeConflict {
  conflict: true;
  files: string[];
}

export class MergeError extends Error {}

const lines = (s: string) => s.split("\n").filter(Boolean);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
    { why: "git.merge" },
  );
  return stdout.trim();
}

export const defaultIntegrationRoot = () => path.join(homedir(), ".llama-mui", "integration");

// Remove an integration worktree and its branch, nothing else. Safe to repeat.
export async function removeIntegration(repo: string, folder: string, integrationBranch: string): Promise<void> {
  await git(repo, "worktree", "remove", "--force", folder).catch(() => "");
  await remove(folder, { recursive: true, force: true }, { why: "merge.cleanup" }).catch(() => {});
  await git(repo, "worktree", "prune").catch(() => "");
  await git(repo, "branch", "-D", integrationBranch).catch(() => "");
}

export async function prepareMerge(repo: string, branch: string, opts: PrepareOptions = {}): Promise<PreparedMerge | MergeConflict> {
  const main = await realpath(await git(repo, "rev-parse", "--show-toplevel").catch(() => {
    throw new MergeError("This folder is not a git repository.");
  }));
  const base = await git(main, "symbolic-ref", "--short", "HEAD").catch(() => {
    throw new MergeError("The main folder is not on a branch.");
  });
  if (branch === base) throw new MergeError("That is the main branch itself.");
  await git(main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => {
    throw new MergeError(`There is no branch called ${branch}.`);
  });
  const baseTip = await git(main, "rev-parse", base);

  // git cherry lists oldest first; '+' is a change the base lacks.
  const todo = lines(await git(main, "cherry", base, branch))
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1).trim());
  if (todo.length === 0) throw new MergeError("Nothing to merge: every change is already on the main branch.");

  const root = opts.integrationRoot ?? defaultIntegrationRoot();
  const short = createHash("sha1").update(main).digest("hex").slice(0, 8);
  const folder = path.join(root, `${path.basename(main)}-${short}`, branch);
  const integrationBranch = `llama/integration/${branch}`;
  await mkdir(path.dirname(folder), { recursive: true }, { why: "merge.worktree" });
  await git(main, "worktree", "add", "-b", integrationBranch, folder, baseTip).catch((e) => {
    throw new MergeError(`Could not set up the integration folder: ${String(e?.stderr || e?.message || e).trim()}`);
  });

  try {
    for (const sha of todo) {
      try {
        await git(folder, "cherry-pick", "--allow-empty", "--keep-redundant-commits", sha);
      } catch (e) {
        const files = lines(await git(folder, "diff", "--name-only", "--diff-filter=U").catch(() => ""));
        if (files.length === 0) throw e; // not a conflict: some other failure
        await git(folder, "cherry-pick", "--abort").catch(() => "");
        await removeIntegration(main, folder, integrationBranch);
        return { conflict: true, files };
      }
    }
  } catch (e) {
    await git(folder, "cherry-pick", "--abort").catch(() => "");
    await removeIntegration(main, folder, integrationBranch);
    throw new MergeError(`Could not replay the commits: ${String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim()}`);
  }
  return { base, baseTip, branch, integrationBranch, folder, repo: main, replayed: todo.length };
}

// ---- Approve and discard ----

// A prepared merge plus the results of its checks: what approval looks at.
export interface MergeAttempt extends PreparedMerge {
  checks: CheckResult[];
  // How many checks the run was meant to have; fewer results means it stopped early.
  expectedChecks?: number;
}

export interface MergedResult {
  merged: true;
  base: string;
  from: string;
  to: string;
  commits: number;
}

const gitMessage = (e: unknown) => String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();

// Moves main to the integration branch, only if the checks passed and main is
// still where the replay started. The move is a fast-forward run in the main
// folder: git itself refuses when a file it would change has uncommitted edits,
// and then nothing moves. On success the integration folder and branch go away.
export async function approveMerge(repo: string, attempt: MergeAttempt): Promise<MergedResult> {
  const main = attempt.repo || repo;
  if (attempt.checks.length === 0 || attempt.checks.some((c) => !c.ok) || (attempt.expectedChecks !== undefined && attempt.checks.length < attempt.expectedChecks)) {
    throw new MergeError("The checks have not all passed, so main was not changed.");
  }
  const current = await git(main, "symbolic-ref", "--short", "HEAD").catch(() => "");
  if (current !== attempt.base) throw new MergeError(`The main folder is no longer on ${attempt.base}, so main was not changed.`);
  const tip = await git(main, "rev-parse", attempt.base);
  if (tip !== attempt.baseTip) throw new MergeError(`${attempt.base} has moved since the merge was prepared, so nothing was merged. Start the merge again.`);

  const to = await git(main, "rev-parse", attempt.integrationBranch).catch(() => {
    throw new MergeError("The prepared merge is gone, so main was not changed.");
  });
  try {
    await git(main, "merge", "--ff-only", attempt.integrationBranch);
  } catch (e) {
    const msg = gitMessage(e);
    if (/local changes|untracked working tree files|would be overwritten/i.test(msg)) {
      throw new MergeError("Some files this merge changes have uncommitted edits in the main folder, so main was not changed. Commit or set those edits aside, then approve again.");
    }
    throw new MergeError(`Git could not move ${attempt.base}: ${msg}`);
  }
  await removeIntegration(main, attempt.folder, attempt.integrationBranch);
  audit("merge.approved", {
    repo: main,
    branch: attempt.branch,
    base: attempt.base,
    from: attempt.baseTip,
    to,
    commits: attempt.replayed,
    checks: attempt.checks.map((c) => ({ name: c.name, ok: c.ok })),
    approvedBy: "user",
  });
  return { merged: true, base: attempt.base, from: attempt.baseTip, to, commits: attempt.replayed };
}

// Throws the prepared merge away: its folder and branch, nothing else.
export async function discardMerge(repo: string, attempt: MergeAttempt): Promise<void> {
  const main = attempt.repo || repo;
  await removeIntegration(main, attempt.folder, attempt.integrationBranch);
  audit("merge.discarded", { repo: main, branch: attempt.branch });
}

// ---- Checks ----

export interface MergeCheck {
  name: string;
  command: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  // The last 40 lines of what the command printed.
  output: string;
  seconds: number;
}

const TAIL_LINES = 40;
const CHECK_TIMEOUT_MS = 10 * 60_000;

const tail = (s: string) => s.replace(/\s+$/, "").split("\n").slice(-TAIL_LINES).join("\n");

// The checks used when the setting is empty: the project's own test and build
// scripts from package.json, when it has them (the build runs the type check).
export async function defaultMergeChecks(repo: string): Promise<MergeCheck[]> {
  try {
    const scripts = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"))?.scripts ?? {};
    return (["test", "build"] as const).filter((n) => typeof scripts[n] === "string").map((n) => ({ name: n, command: `npm run ${n}` }));
  } catch {
    return [];
  }
}

// The checks a merge runs: the saved setting if it has entries, else the default.
export async function mergeChecksFor(repo: string): Promise<MergeCheck[]> {
  const saved = (await load()).mergeChecks;
  const valid = Array.isArray(saved) ? saved.filter((c) => c && typeof c.name === "string" && typeof c.command === "string" && c.command.trim()) : [];
  return valid.length > 0 ? valid : defaultMergeChecks(repo);
}

// Runs each check in the integration folder, in order, and stops at the first
// failure. The main folder's node_modules is linked in first, since a worktree
// holds only tracked files.
export async function runChecks(folder: string, checks: MergeCheck[], opts: { mainFolder?: string; onStart?: (name: string) => void } = {}): Promise<CheckResult[]> {
  if (opts.mainFolder) {
    const source = path.join(opts.mainFolder, "node_modules");
    const link = path.join(folder, "node_modules");
    if (existsSync(source) && !existsSync(link)) await symlink(source, link, "dir", { why: "merge.check.modules" }).catch(() => {});
  }
  const results: CheckResult[] = [];
  for (const check of checks) {
    opts.onStart?.(check.name);
    const started = Date.now();
    let ok = true;
    let out = "";
    try {
      const r = await execFile("sh", ["-c", `(${check.command}) 2>&1`], { cwd: folder, timeout: CHECK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, { why: "git.merge.check" });
      out = r.stdout;
    } catch (e) {
      ok = false;
      const err = e as { stdout?: string; stderr?: string; message?: string };
      out = `${err.stdout ?? ""}${err.stderr ?? ""}` || String(err.message ?? e);
    }
    results.push({ name: check.name, ok, output: tail(out), seconds: Math.round((Date.now() - started) / 100) / 10 });
    if (!ok) break;
  }
  return results;
}
