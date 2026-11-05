import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Never the real ~/.llama-mui or any repo: the home folder is a temp one.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { worktreeStatuses } = await import("../worktreeStatus.ts");
const { sessionFolder } = await import("../sessionFile.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

let n = 0;
// A repo with one commit and a worktree `name` of it in session `id`.
async function setup(name = "ui") {
  const id = `sess-${++n}`;
  const repo = path.join(home.dir, "Projects", `app${n}`);
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  const wt = path.join(sessionFolder(id), "worktrees", name);
  await mkdir(path.dirname(wt), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", `llama/${name}`, wt);
  return { id, repo, wt, messages: made(repo, wt, name) };
}

// The messages a session has after create_worktree worked.
let c = 0;
function made(repo: string, wt: string, name: string, ok = true) {
  const id = `call-${++c}`;
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: "create_worktree", arguments: JSON.stringify({ repo, name }) }] },
    {
      role: "tool",
      toolCallId: id,
      content: ok
        ? `Created a worktree of ${repo} at ${wt} on a new branch llama/${name}, from HEAD. Use it.`
        : `${wt} already exists; pick another name`,
    },
  ];
}

describe("worktreeStatuses", () => {
  it("a clean worktree on main's tip has nothing left", async () => {
    const { id, messages } = await setup();
    expect(await worktreeStatuses(id, messages)).toEqual([
      { name: "ui", branch: "llama/ui", uncommitted: 0, unmerged: 0, base: "main" },
    ]);
  });

  it("counts uncommitted files, untracked ones too", async () => {
    const { id, wt, messages } = await setup();
    await writeFile(path.join(wt, "a.txt"), "changed\n");
    await mkdir(path.join(wt, "dir"));
    await writeFile(path.join(wt, "dir", "x.txt"), "x");
    await writeFile(path.join(wt, "dir", "y.txt"), "y");
    const [w] = await worktreeStatuses(id, messages);
    expect(w.uncommitted).toBe(3);
    expect(w.unmerged).toBe(0);
  });

  it("counts commits that main doesn't have", async () => {
    const { id, wt, messages } = await setup();
    await writeFile(path.join(wt, "b.txt"), "b");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-q", "-m", "b");
    await writeFile(path.join(wt, "c.txt"), "c");
    git(wt, "add", "c.txt");
    git(wt, "commit", "-q", "-m", "c");
    const [w] = await worktreeStatuses(id, messages);
    expect(w).toMatchObject({ uncommitted: 0, unmerged: 2 });
  });

  it("main moving on does not count as unmerged", async () => {
    const { id, repo, messages } = await setup();
    await writeFile(path.join(repo, "m.txt"), "m");
    git(repo, "add", "m.txt");
    git(repo, "commit", "-q", "-m", "main moves");
    expect((await worktreeStatuses(id, messages))[0]).toMatchObject({ unmerged: 0, base: "main" });
  });

  it("a branch merged into main has nothing left", async () => {
    const { id, repo, wt, messages } = await setup();
    await writeFile(path.join(wt, "b.txt"), "b");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-q", "-m", "b");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "llama/ui");
    expect((await worktreeStatuses(id, messages))[0]).toMatchObject({ unmerged: 0, uncommitted: 0 });
  });

  it("uses the branch checked out in the main checkout, not a fixed name", async () => {
    const { id, repo, messages } = await setup();
    git(repo, "checkout", "-q", "-b", "develop");
    expect((await worktreeStatuses(id, messages))[0]).toMatchObject({ base: "develop", unmerged: 0 });
  });

  it("a removed worktree is left out", async () => {
    const { id, wt, messages } = await setup();
    await rm(wt, { recursive: true });
    expect(await worktreeStatuses(id, messages)).toEqual([]);
  });

  it("a thread with no create_worktree call has none, even if a worktree is in its folder", async () => {
    const { id } = await setup();
    expect(await worktreeStatuses(id, [])).toEqual([]);
    expect(await worktreeStatuses("no-such-session", [])).toEqual([]);
  });

  it("a failed create_worktree call shows nothing", async () => {
    const { id, repo, wt } = await setup();
    expect(await worktreeStatuses(id, made(repo, wt, "ui", false))).toEqual([]);
  });

  it("ignores a worktree outside the session's own folder", async () => {
    const { id, repo, wt } = await setup();
    const other = path.join(home.dir, "elsewhere");
    expect(await worktreeStatuses(id, made(repo, other, "x"))).toEqual([]);
    expect(wt).toBeTruthy();
  });

  it("lists every worktree the thread made, and not one it didn't", async () => {
    const { id, repo, messages } = await setup("one");
    const two = path.join(sessionFolder(id), "worktrees", "two");
    git(repo, "worktree", "add", "-q", "-b", "llama/two", two);
    git(repo, "worktree", "add", "-q", "-b", "llama/three", path.join(sessionFolder(id), "worktrees", "three"));
    const all = [...messages, ...made(repo, two, "two")];
    expect((await worktreeStatuses(id, all)).map((w) => w.name)).toEqual(["one", "two"]);
  });
});
