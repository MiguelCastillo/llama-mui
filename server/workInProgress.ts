// Everything in one repo that is started but not yet in the main branch: extra
// worktrees, local branches with unmerged commits that no worktree holds, and
// uncommitted files in the main folder. Read from git on demand, never stored,
// never modifies anything. A broken entry is left out; it never fails the answer.

import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createdWorktrees } from "./createdWorktrees.ts";
import { sessionsDir } from "./disk.ts";
import { execFile } from "./io/exec.ts";
import { readSession } from "./sessionFile.ts";

export const FILES_CAP = 50;
// How many worktrees are read from git at the same time.
export const WORKTREES_AT_ONCE = 4;

export interface WorkEntry {
  kind: "worktree" | "branch" | "loose";
  name: string;
  // Null for loose files in the main folder (and a detached worktree).
  branch: string | null;
  // The folder holding the work; the main folder for a branch with no worktree.
  folder: string;
  // Files with changes not committed, untracked ones included.
  uncommitted: number;
  // Commits on the branch that aren't on the base; null when unknown.
  unmerged: number | null;
  // Files changed versus the base, names capped at FILES_CAP; total is the full count.
  files: string[];
  filesTotal: number;
  lastCommitSubject: string | null;
  // Unix seconds of the last commit; null when unknown.
  lastCommitTime: number | null;
  // True when every change on the branch is already on the base (compared by
  // patch id, so a branch replayed with new commit ids counts as merged).
  merged: boolean;
  // What the set of changes is for, in one line: the owning session's plan
  // summary, else the last commit's first line, else null.
  purpose: string | null;
  // The session that made the work (its id opens that chat); null when unknown
  // and for loose files.
  source: string | null;
}

// What the owner lookup needs from a saved session.
export interface SessionInfo {
  id: string;
  planSummary?: string | null;
  messages?: unknown;
}

export interface WipOptions {
  // Where sessions' own worktree folders live (default ~/.llama-mui/sessions).
  sessionsRoot?: string;
  // All saved sessions; default reads them from disk. Only called when a
  // worktree could not be placed by its folder alone.
  loadSessions?: () => Promise<SessionInfo[]>;
}

async function loadSavedSessions(root: string): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  for (const id of await readdir(root).catch(() => [] as string[])) {
    try {
      const s = await readSession(id);
      if (s) out.push({ id, planSummary: typeof s.planSummary === "string" ? s.planSummary : null, messages: s.messages });
    } catch {
      // an unreadable session owns nothing
    }
  }
  return out;
}

const real = (p: string) => realpath(p).catch(() => p);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    },
    // Polled, read-only checks that carry no decision: not audited (guide, "The audit log").
    // Only read-only git commands may go through this helper.
    { why: "git.status", quiet: true },
  );
  return stdout.trim();
}

const lines = (s: string) => s.split("\n").filter(Boolean);

async function uncommittedIn(dir: string): Promise<number> {
  return lines(await git(dir, "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all").catch(() => "")).length;
}

async function describeRef(dir: string, ref: string, base: string | null) {
  let unmerged: number | null = null;
  let files: string[] = [];
  if (base) {
    // git cherry compares by patch id: '+' is a change the base lacks, '-' is one
    // it already has (even under a new commit id, e.g. after a replay).
    const cherry = await git(dir, "cherry", base, ref).catch(() => null);
    if (cherry !== null) {
      unmerged = lines(cherry).filter((l) => l.startsWith("+")).length;
    } else {
      const n = Number(await git(dir, "rev-list", "--count", `${base}..${ref}`).catch(() => ""));
      unmerged = Number.isInteger(n) ? n : null;
    }
    // Changes the branch made since it left the base (three dots).
    files = lines(await git(dir, "diff", "--name-only", `${base}...${ref}`).catch(() => ""));
  }
  const [subject, time] = (await git(dir, "log", "-1", "--format=%s%x00%ct", ref).catch(() => "")).split("\0");
  const t = Number(time);
  return {
    unmerged,
    files: files.slice(0, FILES_CAP),
    filesTotal: files.length,
    lastCommitSubject: subject || null,
    lastCommitTime: Number.isFinite(t) && time ? t : null,
  };
}

interface Tree {
  folder: string;
  branch: string | null;
}

function parseWorktrees(out: string): Tree[] {
  const trees: Tree[] = [];
  for (const block of out.split("\n\n")) {
    let folder = "";
    let branch: string | null = null;
    for (const line of lines(block)) {
      if (line.startsWith("worktree ")) folder = line.slice(9);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    if (folder) trees.push({ folder, branch });
  }
  return trees;
}

export async function workInProgress(repo: string, opts: WipOptions = {}): Promise<WorkEntry[]> {
  try {
    const root = opts.sessionsRoot ?? sessionsDir;
    const loadSessions = opts.loadSessions ?? (() => loadSavedSessions(root));
    const rootReal = await real(root);
    const main = await realpath(await git(repo, "rev-parse", "--show-toplevel"));
    const trees = parseWorktrees(await git(main, "worktree", "list", "--porcelain"));
    const base = await git(main, "symbolic-ref", "--short", "HEAD").catch(() => null);
    const entries: WorkEntry[] = [];

    // Saved chats are read at most once, shared by every worktree.
    let sessionsOnce: Promise<SessionInfo[]> | null = null;
    const getSessions = () => (sessionsOnce ??= loadSessions().catch(() => []));

    const describeTree = async (t: Tree): Promise<WorkEntry | null> => {
      if ((await realpath(t.folder).catch(() => t.folder)) === main) return null;
      try {
        const ref = t.branch ?? "HEAD";
        const [d, uncommitted, folderReal] = await Promise.all([describeRef(t.folder, ref, base), uncommittedIn(t.folder), real(t.folder)]);
        // A server-made worktree sits at <root>/<session id>/worktrees/<name>.
        const rel = path.relative(rootReal, folderReal).split(path.sep);
        let source: string | null = rel.length === 3 && rel[1] === "worktrees" && !rel[0].startsWith("..") ? rel[0] : null;
        const sessions = await getSessions();
        const owner = source
          ? sessions.find((s) => s.id === source)
          : sessions.find((s) => createdWorktrees(s.messages).some((w) => w.path === t.folder || w.path === folderReal));
        source = owner?.id ?? source;
        // Already in the main branch and nothing left uncommitted: nothing to track.
        if (d.unmerged === 0 && uncommitted === 0) return null;
        return {
          kind: "worktree",
          name: path.basename(t.folder),
          branch: t.branch,
          folder: t.folder,
          uncommitted,
          ...d,
          // Leftover uncommitted files still need cleaning up, so they are never "merged".
          merged: d.unmerged === 0 && uncommitted === 0,
          purpose: owner?.planSummary?.trim() || d.lastCommitSubject,
          source,
        };
      } catch {
        return null; // one broken worktree is left out
      }
    };

    // At most WORKTREES_AT_ONCE worktrees at a time; results keep the order git listed them in.
    const described: (WorkEntry | null)[] = new Array(trees.length).fill(null);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(WORKTREES_AT_ONCE, trees.length) }, async () => {
        while (next < trees.length) {
          const i = next++;
          described[i] = await describeTree(trees[i]);
        }
      }),
    );
    for (const e of described) if (e) entries.push(e);

    if (base) {
      const held = new Set(trees.map((t) => t.branch).filter(Boolean));
      const unmergedBranches = lines(await git(main, "branch", "--format=%(refname:short)", "--no-merged", base).catch(() => ""));
      for (const b of unmergedBranches) {
        if (held.has(b)) continue;
        try {
          const d = await describeRef(main, b, base);
          // Every change already on the base (replayed under new ids): nothing to track.
          if (d.unmerged === 0) continue;
          entries.push({ kind: "branch", name: b, branch: b, folder: main, uncommitted: 0, ...d, merged: false, purpose: d.lastCommitSubject, source: null });
        } catch {
          // left out
        }
      }
    }

    const loose = await uncommittedIn(main);
    if (loose > 0) {
      const last = await describeRef(main, "HEAD", null);
      entries.push({
        kind: "loose",
        name: path.basename(main),
        branch: base,
        folder: main,
        uncommitted: loose,
        unmerged: null,
        files: [],
        filesTotal: 0,
        lastCommitSubject: last.lastCommitSubject,
        lastCommitTime: last.lastCommitTime,
        merged: false,
        purpose: null,
        source: null,
      });
    }
    return entries;
  } catch {
    return [];
  }
}
