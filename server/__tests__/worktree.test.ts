import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui or any repo.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { toolRoutes } = await import("../tools.ts");
const { sessionsDir } = await import("../disk.ts");
const { worktreeTarget, worktreesFolder } = await import("../worktree.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const repo = path.join(home.dir, "Projects", "app");

// A repo with one commit, a .gitignore, and an ignored .env that isn't tracked.
async function makeRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "README.md"), "hello\n");
  await writeFile(path.join(dir, ".gitignore"), ".env\n");
  await writeFile(path.join(dir, ".env"), "SECRET=1\n");
  git(dir, "add", "README.md", ".gitignore");
  git(dir, "commit", "-q", "-m", "init");
}

const call = async (name: string, args: object, chatId = "sess-1", approved?: object) => {
  const body = { name, arguments: args, chatId, attachments: [], approved };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "call"], method: "POST", search: "" });
  return JSON.parse(text);
};

const worktree = (name: string, chatId = "sess-1") => path.join(sessionsDir, chatId, "worktrees", name);
const exists = (p: string) => stat(p).then(() => true, () => false);

await makeRepo(repo);
git(repo, "branch", "llama/ask-branch-taken");

describe("create_worktree", () => {
  it("makes the worktree at once, without asking, and says where", async () => {
    const out = await call("create_worktree", { repo, name: "ask" });
    expect(out.needsApproval).toBeUndefined();
    expect(out.needsAccess).toBeUndefined();
    expect(out.result).toContain(`at ${worktree("ask")}`);
    expect(out.result).not.toMatch(/approv/i);
    expect(await exists(worktree("ask"))).toBe(true);
    expect(git(repo, "branch", "--list", "llama/ask")).toContain("llama/ask");
  });

  it("makes the worktree on a new branch, holding only tracked files", async () => {
    const { result } = await call("create_worktree", { repo, name: "made" });
    expect(result).toContain("Created a worktree");
    expect(await readFile(path.join(worktree("made"), "README.md"), "utf8")).toBe("hello\n");
    expect(await exists(path.join(worktree("made"), ".env"))).toBe(false);
    expect(git(repo, "branch", "--list", "llama/made")).toContain("llama/made");
  });

  it("lets the model write in it with no approval", async () => {
    await call("create_worktree", { repo, name: "free" });
    const out = await call("write_file", { path: path.join(worktree("free"), "src", "a.ts"), content: "x\n" });
    expect(out.result).toContain("Created");
    expect(out.needsApproval).toBeUndefined();
    expect(out.needsAccess).toBeUndefined();
  });

  it("uses the repo's root when pointed at a folder inside it", async () => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    const out = await call("create_worktree", { repo: path.join(repo, "src"), name: "from-src" });
    expect(out.result).toContain(`worktree of ${repo} at ${worktree("from-src")}`);
  });

  it("starts from the base it is given", async () => {
    const before = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "later.txt"), "later\n");
    git(repo, "add", "later.txt");
    git(repo, "commit", "-q", "-m", "later");
    await call("create_worktree", { repo, name: "based", base: before });
    expect(git(worktree("based"), "rev-parse", "HEAD")).toBe(before);
  });

  it.each([
    ["a repo outside the home folder", async () => ({ repo: await outside(), name: "x" }), "outside your home folder"],
    ["a repo inside ~/.llama-mui", async () => ({ repo: await insideApp(), name: "x" }), "app's own data"],
    ["a folder that is not a git repo", async () => ({ repo: await plain(), name: "x" }), "not in a git repository"],
    ["a folder that does not exist", async () => ({ repo: path.join(home.dir, "nope"), name: "x" }), "does not exist"],
    ["a name that is already a worktree", async () => ({ repo, name: "made" }), "already exists"],
    ["a branch that already exists", async () => ({ repo, name: "ask-branch-taken" }), "already exists"],
    ["a name with ..", async () => ({ repo, name: "a..b" }), "isn't a usable worktree name"],
    ["a name that starts with a dash", async () => ({ repo, name: "-x" }), "isn't a usable worktree name"],
    ["a name that climbs out with ../", async () => ({ repo, name: "../x" }), "isn't a usable worktree name"],
    ["an absolute path as the name", async () => ({ repo, name: "/tmp/x" }), "isn't a usable worktree name"],
    ["a name with a separator", async () => ({ repo, name: "a/b" }), "isn't a usable worktree name"],
    ["a name with a backslash", async () => ({ repo, name: "a\\b" }), "isn't a usable worktree name"],
    ["a base that is not a commit", async () => ({ repo, name: "badbase", base: "nope" }), "isn't a commit"],
    ["a base that looks like an option", async () => ({ repo, name: "optbase", base: "--help" }), "isn't a commit"],
  ])("refuses %s, without asking", async (_label, args, message) => {
    const out = await call("create_worktree", await args());
    expect(out.needsApproval).toBeUndefined();
    expect(out.result).toContain("Error:");
    expect(out.result).toContain(message);
  });

  it("refuses a session id that can't be a folder name", async () => {
    const out = await call("create_worktree", { repo, name: "badsession" }, "Bad_Id");
    expect(out.result).toContain("no folder for worktrees");
  });

  it("refuses with no session id, and makes nothing anywhere else", async () => {
    const out = await call("create_worktree", { repo, name: "nosession" }, "");
    expect(out.needsApproval).toBeUndefined();
    expect(out.result).toContain("Error:");
    expect(out.result).toContain("no session id");
    expect(git(repo, "branch", "--list", "llama/nosession")).toBe("");
    for (const stray of [
      path.join(sessionsDir, "worktrees", "nosession"),
      path.join(sessionsDir, "nosession"),
      path.join(home.dir, "worktrees", "nosession"),
      path.join(process.cwd(), "worktrees", "nosession"),
    ]) {
      expect(await exists(stray)).toBe(false);
    }
  });
});

describe("where a worktree goes", () => {
  const ctx = (chatId: string) => ({ chatId, attachments: [] }) as unknown as Parameters<typeof worktreesFolder>[0];

  it("is the open session's own folder, built from its id", () => {
    expect(worktreesFolder(ctx("sess-1"))).toBe(path.join(home.dir, ".llama-mui", "sessions", "sess-1", "worktrees"));
    expect(worktreesFolder(ctx("sess-2"))).toBe(path.join(home.dir, ".llama-mui", "sessions", "sess-2", "worktrees"));
  });

  it.each(["a", "my-app", "app.v2", "A_b-1"])("puts %s directly inside that folder", (name) => {
    const folder = worktreesFolder(ctx("sess-1"));
    expect(worktreeTarget(ctx("sess-1"), name)).toBe(path.join(folder, name));
  });

  it.each(["../x", "/tmp/x", "a/b", "-x", "..", ".", "", ".hidden", "a/../../x", "x\\..\\y"])(
    "never makes a target from %j",
    (name) => {
      expect(() => worktreeTarget(ctx("sess-1"), name)).toThrow(/isn't a usable worktree name/);
    },
  );

  it.each(["", "Bad_Id", "../other", "a/b"])("has no folder for the session id %j, and no other place instead", (chatId) => {
    expect(() => worktreesFolder(ctx(chatId))).toThrow(/no folder for worktrees/);
    expect(() => worktreeTarget(ctx(chatId), "fine")).toThrow(/no folder for worktrees/);
  });
});

describe("remove_worktree", () => {
  it("refuses a worktree with uncommitted changes", async () => {
    await call("create_worktree", { repo, name: "dirty" });
    await writeFile(path.join(worktree("dirty"), "new.txt"), "unsaved\n");
    const out = await call("remove_worktree", { name: "dirty" });
    expect(out.needsApproval).toBeUndefined();
    expect(out.result).toContain("uncommitted");
    expect(await exists(worktree("dirty"))).toBe(true);
  });

  it("shows what goes, then removes the worktree and keeps its branch", async () => {
    await call("create_worktree", { repo, name: "clean" });
    const first = await call("remove_worktree", { name: "clean" });
    expect(first.needsApproval).toEqual({
      type: "worktree",
      action: "remove",
      repo,
      branch: "llama/clean",
      path: worktree("clean"),
    });
    expect(await exists(worktree("clean"))).toBe(true);
    const done = await call("remove_worktree", { name: "clean" }, "sess-1", first.needsApproval);
    expect(done.result).toContain("Removed the worktree");
    expect(await exists(worktree("clean"))).toBe(false);
    expect(git(repo, "branch", "--list", "llama/clean")).toContain("llama/clean");
  });

  it("carries the model's reason in the approval when given, and omits it otherwise", async () => {
    await call("create_worktree", { repo, name: "why" });
    const plain = await call("remove_worktree", { name: "why" });
    expect("reason" in plain.needsApproval).toBe(false);

    const args = { name: "why", reason: "  Cleaning up the worktree you're done with  " };
    const first = await call("remove_worktree", args);
    expect(first.needsApproval).toEqual({
      type: "worktree",
      action: "remove",
      repo,
      branch: "llama/why",
      path: worktree("why"),
      reason: "Cleaning up the worktree you're done with",
    });
    // Re-run with the same args, it matches what was shown and goes ahead.
    const done = await call("remove_worktree", args, "sess-1", first.needsApproval);
    expect(done.result).toContain("Removed the worktree");
    expect(await exists(worktree("why"))).toBe(false);
  });

  it("refuses a name that isn't one of this session's worktrees", async () => {
    expect((await call("remove_worktree", { name: "ghost" })).result).toContain("no worktree named ghost");
    expect((await call("remove_worktree", { name: "made" }, "sess-2")).result).toContain("no worktree named made");
  });
});

async function outside() {
  const dir = await mkdtemp(path.join(path.dirname(home.dir), "llama-mui-outside-"));
  await makeRepo(dir);
  return dir;
}

async function insideApp() {
  const dir = path.join(home.dir, ".llama-mui", "somewhere");
  await makeRepo(dir);
  return dir;
}

async function plain() {
  const dir = path.join(home.dir, "Projects", "plain");
  await mkdir(dir, { recursive: true });
  return dir;
}
