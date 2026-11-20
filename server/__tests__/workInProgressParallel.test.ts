import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Home is a temp folder before anything loads: never the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { workInProgress } = await import("../workInProgress.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

describe("workInProgress with several worktrees", () => {
  it("keeps git's order, leaves a broken worktree out, and loads chats once", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wip-par-")));
    const repo = path.join(root, "repo");
    git(root, "init", "-b", "main", repo);
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "first");
    const names = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];
    for (const n of names) {
      const wt = path.join(root, n);
      git(repo, "worktree", "add", "-b", n, wt);
      writeFileSync(path.join(wt, `${n}.txt`), n);
      git(wt, "add", "-A");
      git(wt, "commit", "-m", `add ${n}`);
    }
    // w3's folder disappears: git still lists it, reading it fails, it is left out.
    rmSync(path.join(root, "w3"), { recursive: true });

    let loads = 0;
    const list = await workInProgress(repo, {
      sessionsRoot: path.join(root, "sessions"),
      loadSessions: async () => {
        loads++;
        return [];
      },
    });
    const worktrees = list.filter((e) => e.kind === "worktree").map((e) => e.name);
    const listed = git(repo, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => path.basename(l.slice(9)))
      .filter((n) => n !== "repo" && n !== "w3");
    expect(worktrees).toEqual(listed);
    expect(worktrees).not.toContain("w3");
    expect(worktrees.length).toBe(6);
    expect(loads).toBe(1);
  });
});
