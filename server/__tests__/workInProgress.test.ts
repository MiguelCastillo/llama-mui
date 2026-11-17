import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workInProgress } from "../workInProgress.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function makeRepo() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wip-")));
  const repo = path.join(root, "repo");
  git(root, "init", "-b", "main", repo);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "first");
  return { root, repo };
}

describe("workInProgress", () => {
  it("is empty for a clean repo and for a folder that is not a repo", async () => {
    const { repo } = makeRepo();
    expect(await workInProgress(repo)).toEqual([]);
    expect(await workInProgress(realpathSync(mkdtempSync(path.join(tmpdir(), "nogit-"))))).toEqual([]);
  });

  it("lists a worktree with its size, uncommitted files and last commit", async () => {
    const { root, repo } = makeRepo();
    const wt = path.join(root, "feat");
    git(repo, "worktree", "add", "-b", "feat", wt);
    writeFileSync(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "add b");
    writeFileSync(path.join(wt, "c.txt"), "c\n");
    const [e, ...rest] = await workInProgress(repo);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      kind: "worktree",
      name: "feat",
      branch: "feat",
      folder: wt,
      uncommitted: 1,
      unmerged: 1,
      files: ["b.txt"],
      filesTotal: 1,
      lastCommitSubject: "add b",
      merged: false,
    });
    expect(e.lastCommitTime).toBeGreaterThan(0);
  });

  it("lists an unmerged branch with no worktree, but not a merged one or one a worktree holds", async () => {
    const { root, repo } = makeRepo();
    git(repo, "checkout", "-b", "old");
    writeFileSync(path.join(repo, "o.txt"), "o\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "old work");
    git(repo, "checkout", "main");
    git(repo, "branch", "done");
    git(repo, "worktree", "add", "-b", "held", path.join(root, "held"));
    writeFileSync(path.join(root, "held", "h.txt"), "h\n");
    git(path.join(root, "held"), "add", "-A");
    git(path.join(root, "held"), "commit", "-m", "held work");
    const all = await workInProgress(repo);
    expect(all.filter((e) => e.kind === "branch").map((e) => e.name)).toEqual(["old"]);
    expect(all.filter((e) => e.kind === "worktree").map((e) => e.name)).toEqual(["held"]);
    const old = all.find((e) => e.name === "old")!;
    expect(old).toMatchObject({ unmerged: 1, files: ["o.txt"], lastCommitSubject: "old work", merged: false });
  });

  it("counts a branch replayed onto main with new commit ids as merged and drops it from the branch list", async () => {
    const { repo } = makeRepo();
    git(repo, "checkout", "-b", "replayed");
    writeFileSync(path.join(repo, "r.txt"), "r\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "r work");
    git(repo, "checkout", "main");
    git(repo, "cherry-pick", "replayed");
    expect((await workInProgress(repo)).filter((e) => e.kind === "branch")).toEqual([]);
  });

  it("counts only the changes main lacks when a branch has one new and one replayed commit", async () => {
    const { root, repo } = makeRepo();
    const wt = path.join(root, "mix");
    git(repo, "worktree", "add", "-b", "mix", wt);
    writeFileSync(path.join(wt, "one.txt"), "1\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "one");
    writeFileSync(path.join(wt, "two.txt"), "2\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "two");
    git(repo, "cherry-pick", "mix~1");
    const [e] = await workInProgress(repo);
    expect(e).toMatchObject({ kind: "worktree", name: "mix", unmerged: 1, merged: false });
  });

  it("leaves out a worktree already merged into the base with nothing uncommitted", async () => {
    const { root, repo } = makeRepo();
    git(repo, "worktree", "add", "-b", "same", path.join(root, "same"));
    expect(await workInProgress(repo)).toEqual([]);
  });

  it("keeps a merged worktree that still has uncommitted files", async () => {
    const { root, repo } = makeRepo();
    const wt = path.join(root, "same");
    git(repo, "worktree", "add", "-b", "same", wt);
    writeFileSync(path.join(wt, "left.txt"), "x\n");
    const [e] = await workInProgress(repo);
    expect(e).toMatchObject({ kind: "worktree", unmerged: 0, merged: true, uncommitted: 1 });
  });

  it("reports uncommitted files in the main folder as one loose entry", async () => {
    const { repo } = makeRepo();
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    writeFileSync(path.join(repo, "new.txt"), "n\n");
    const all = await workInProgress(repo);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "loose", branch: "main", folder: repo, uncommitted: 2, lastCommitSubject: "first" });
  });

  it("caps the file names but keeps the full total", async () => {
    const { root, repo } = makeRepo();
    const wt = path.join(root, "big");
    git(repo, "worktree", "add", "-b", "big", wt);
    for (let i = 0; i < 55; i++) writeFileSync(path.join(wt, `f${i}.txt`), "x\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "many");
    const [e] = await workInProgress(repo);
    expect(e.files).toHaveLength(50);
    expect(e.filesTotal).toBe(55);
  });

  describe("purpose and source", () => {
    const made = (repo: string, wt: string, branch: string) => [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "create_worktree" }] },
      { role: "tool", toolCallId: "c1", content: `Created a worktree of ${repo} at ${wt} on a new branch ${branch}, from main. x` },
    ];

    it("uses the owning session's plan summary and names the session (worktree made by create_worktree)", async () => {
      const { root, repo } = makeRepo();
      const wt = path.join(root, "feat");
      git(repo, "worktree", "add", "-b", "feat", wt);
      writeFileSync(path.join(wt, "b.txt"), "b\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-m", "add b");
      const loadSessions = async () => [
        { id: "other", planSummary: "Not this one", messages: [] },
        { id: "s1", planSummary: "  Make the pane show purposes  ", messages: made(repo, wt, "feat") },
      ];
      const [e] = await workInProgress(repo, { sessionsRoot: path.join(root, "sessions"), loadSessions });
      expect(e).toMatchObject({ purpose: "Make the pane show purposes", source: "s1" });
    });

    it("places a server-made worktree by its folder, and falls back to the last commit line without a plan summary", async () => {
      const { root, repo } = makeRepo();
      const sessions = path.join(root, "sessions");
      const wt = path.join(sessions, "s2", "worktrees", "thread");
      git(repo, "worktree", "add", "-b", "thread", wt);
      writeFileSync(path.join(wt, "b.txt"), "b\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-m", "Add b\n\nlonger body");
      const loadSessions = async () => [{ id: "s2", planSummary: null, messages: [] }];
      const [e] = await workInProgress(repo, { sessionsRoot: sessions, loadSessions });
      expect(e).toMatchObject({ purpose: "Add b", source: "s2" });
    });

    it("has no source for a branch, and a null purpose and source for loose files", async () => {
      const { repo } = makeRepo();
      git(repo, "checkout", "-b", "old");
      writeFileSync(path.join(repo, "o.txt"), "o\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "old work");
      git(repo, "checkout", "main");
      writeFileSync(path.join(repo, "loose.txt"), "l\n");
      const all = await workInProgress(repo, { loadSessions: async () => [] });
      expect(all.find((e) => e.kind === "branch")).toMatchObject({ purpose: "old work", source: null });
      expect(all.find((e) => e.kind === "loose")).toMatchObject({ purpose: null, source: null });
    });

    it("falls back to the last commit line for a worktree no session claims", async () => {
      const { root, repo } = makeRepo();
      const wt = path.join(root, "w");
      git(repo, "worktree", "add", "-b", "w", wt);
      writeFileSync(path.join(wt, "w.txt"), "w\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-m", "w work");
      const [e] = await workInProgress(repo, { loadSessions: async () => [] });
      expect(e).toMatchObject({ purpose: "w work", source: null });
    });
  });

  it("changes nothing in the repo", async () => {
    const { root, repo } = makeRepo();
    git(repo, "worktree", "add", "-b", "w", path.join(root, "w"));
    writeFileSync(path.join(repo, "x.txt"), "x\n");
    const before = git(repo, "status", "--porcelain") + git(repo, "branch", "-a") + git(repo, "rev-parse", "HEAD");
    await workInProgress(repo);
    expect(git(repo, "status", "--porcelain") + git(repo, "branch", "-a") + git(repo, "rev-parse", "HEAD")).toBe(before);
  });
});
