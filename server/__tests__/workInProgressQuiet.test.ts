import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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
const { execFile } = await import("../io/exec.ts");
const { auditDir } = await import("../audit.ts");

const execLines = () =>
  (existsSync(auditDir()) ? readdirSync(auditDir()) : [])
    .map((f) => readFileSync(path.join(auditDir(), f), "utf8"))
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "io.exec");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

describe("workInProgress audit", () => {
  it("lists work without writing any io.exec line, while an ordinary call still does", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wip-quiet-")));
    const repo = path.join(root, "repo");
    git(root, "init", "-b", "main", repo);
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "first");
    const wt = path.join(root, "feat");
    git(repo, "worktree", "add", "-b", "feat", wt);
    writeFileSync(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "add b");
    git(repo, "branch", "loose", "feat");
    writeFileSync(path.join(wt, "c.txt"), "c\n");

    const before = execLines().length;
    const list = await workInProgress(repo);
    expect(list.length).toBeGreaterThan(0); // it really ran git
    expect(execLines().length).toBe(before);

    await execFile("echo", ["x"], undefined, { why: "test.loud" });
    expect(execLines().length).toBe(before + 1);
  });
});
