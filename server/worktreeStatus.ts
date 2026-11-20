// Where a session's work lives, read from git: for each worktree the session
// created, its branch, how many files are uncommitted, and
// how many commits are not on the branch checked out in the repo's own
// checkout. Read-only and computed on demand, never stored, so it can't go
// stale or be written wrong by a model. One broken worktree is left out; it
// never fails the answer.

import { realpath } from "node:fs/promises";
import path from "node:path";
import { createdWorktrees } from "./createdWorktrees.ts";
import { execFile } from "./io/exec.ts";
import { sessionFolder } from "./sessionFile.ts";

export interface WorktreeStatus {
  name: string;
  // The worktree's branch; null when HEAD is detached.
  branch: string | null;
  // Files with changes not committed, untracked ones included.
  uncommitted: number;
  // Commits on this worktree's HEAD that aren't on `base`; null when unknown.
  unmerged: number | null;
  // The branch checked out in the repo's main working tree; null when unknown.
  base: string | null;
  // The branch's latest commit as "<short hash> <title>"; null when unknown.
  lastCommit: string | null;
  // True when every commit of the branch is already on `base` and nothing is left
  // uncommitted (nothing to merge, nothing to clean up).
  merged: boolean;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    },
    // Read-only status checks that carry no decision: not audited (guide, "The audit log").
    // Only read-only git commands may go through this helper.
    { why: "git.status", quiet: true },
  );
  return stdout.trim();
}

async function statusOf(dir: string, name: string): Promise<WorktreeStatus | null> {
  try {
    // Only a folder that is itself a worktree counts, not one inside some
    // other repo.
    const top = await realpath(await git(dir, "rev-parse", "--show-toplevel"));
    if (top !== (await realpath(dir))) return null;

    const head = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    const branch = head === "HEAD" ? null : head;
    const changes = (await git(dir, "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean);

    let base: string | null = null;
    let unmerged: number | null = null;
    const common = await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => "");
    if (path.basename(common) === ".git") {
      const main = path.dirname(common);
      base = await git(main, "symbolic-ref", "--short", "HEAD").catch(() => null);
      if (base) {
        const n = Number(await git(dir, "rev-list", "--count", `${base}..HEAD`).catch(() => ""));
        unmerged = Number.isInteger(n) ? n : null;
      }
    }
    const lastCommit = (await git(dir, "log", "-1", "--format=%h %s").catch(() => "")) || null;
    return { name, branch, uncommitted: changes.length, unmerged, base, lastCommit, merged: unmerged === 0 && changes.length === 0 };
  } catch {
    return null;
  }
}

// The status of each worktree this session created (its own successful
// create_worktree calls, see createdWorktrees.ts) that still exists. A worktree
// it didn't create, or a call that failed, shows nothing. Empty when none.
export async function worktreeStatuses(sessionId: string, messages: unknown): Promise<WorktreeStatus[]> {
  const folder = path.join(sessionFolder(sessionId), "worktrees");
  // Only the session's own worktrees folder counts, whatever a message says.
  const made = createdWorktrees(messages).filter((w) => path.dirname(w.path) === folder);
  const rows = await Promise.all(made.map((w) => statusOf(w.path, w.name)));
  return rows.filter((r): r is WorktreeStatus => r !== null).sort((a, b) => a.name.localeCompare(b.name));
}
