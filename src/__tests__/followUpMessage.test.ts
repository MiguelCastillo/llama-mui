import { describe, expect, it } from "vitest";
import type { WorkEntry } from "../api";
import { followUpMessage } from "../followUpMessage";

const entry = (over: Partial<WorkEntry> = {}): WorkEntry => ({
  kind: "worktree",
  name: "pin-to-top",
  branch: "llama/pin-to-top",
  folder: "/home/x/worktrees/pin-to-top",
  uncommitted: 2,
  unmerged: 3,
  files: [],
  filesTotal: 0,
  lastCommitSubject: "Pin the chat to the top",
  lastCommitTime: null,
  merged: false,
  purpose: null,
  source: "abc",
  ...over,
});

describe("followUpMessage", () => {
  it("states the branch, folder, counts and last commit", () => {
    const m = followUpMessage(entry());
    expect(m).toContain("llama/pin-to-top");
    expect(m).toContain("/home/x/worktrees/pin-to-top");
    expect(m).toContain("Commits not in main: 3");
    expect(m).toContain("Uncommitted files: 2");
    expect(m).toContain("Last commit: Pin the chat to the top");
  });

  it("asks about replayed or squashed commits, what still exists, and the cleanup list", () => {
    const m = followUpMessage(entry());
    expect(m).toMatch(/replayed or squashed/);
    expect(m).toMatch(/branch and the worktree folder still exist/);
    expect(m).toMatch(/delete the branch, remove the worktree, commit or drop/);
  });

  it("says not to clean up before the user agrees", () => {
    expect(followUpMessage(entry())).toMatch(/Don't delete, remove or discard anything until I agree/);
  });

  it("leaves out what is unknown", () => {
    const m = followUpMessage(entry({ unmerged: null, lastCommitSubject: null }));
    expect(m).not.toContain("Commits not in main");
    expect(m).not.toContain("Last commit");
  });

  it("handles loose files without a branch", () => {
    const m = followUpMessage(entry({ kind: "loose", branch: null, name: "files", unmerged: null }));
    expect(m).not.toContain("Branch:");
    expect(m).toContain("uncommitted files");
  });

  it("handles a branch with no worktree folder", () => {
    const m = followUpMessage(entry({ kind: "branch" }));
    expect(m).not.toContain("Folder:");
  });

  it("for leftover files with no commits ahead, says the work is in main and asks for cleanup", () => {
    const m = followUpMessage(entry({ unmerged: 0, uncommitted: 4 }));
    expect(m).toContain("the work itself is already in main");
    expect(m).toContain("leftover uncommitted files");
    expect(m).toContain("commit or drop them, then remove the worktree");
    expect(followUpMessage(entry({ unmerged: 3, uncommitted: 4 }))).not.toContain("Only leftover uncommitted files remain");
  });
});
