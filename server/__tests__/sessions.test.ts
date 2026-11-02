import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// disk.ts reads the home folder when it loads, so it's pointed at a temp one
// first: these tests must never write in the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { DISK_TOOLS, inSessionWorktrees, sessionsDir } = await import("../disk.ts");
const { WRITE_TOOLS } = await import("../write.ts");
const { AccessNeeded, ApprovalNeeded } = await import("../toolkit.ts");
type Ctx = import("../toolkit.ts").ToolContext;

const tool = (name: string) => [...DISK_TOOLS, ...WRITE_TOOLS].find((t) => t.name === name)!;
const ctx = (attachments: string[] = []) => ({ store: {}, chatId: "chat", attachments, approved: null }) as unknown as Ctx;
const outcome = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ran";
  } catch (e) {
    if (e instanceof AccessNeeded) return "asked for access";
    if (e instanceof ApprovalNeeded) return "asked for approval";
    throw e;
  }
};

const session = path.join(sessionsDir, "abc");
const worktree = path.join(session, "worktrees", "feature");
const chatFile = path.join(session, "chat.json");
const write = (file: string) => tool("write_file").run(ctx(), { path: file, content: "x\n" });
const read = (file: string) => tool("read_file").run(ctx(), { path: file });

describe("a session's worktrees folder", () => {
  it("is under the temp home, not the real one", () => {
    expect(sessionsDir).toBe(path.join(home.dir, ".llama-mui", "sessions"));
  });

  it("takes a new file with no access prompt and no change approval", async () => {
    const file = path.join(worktree, "src", "deep", "a.txt");
    expect(await outcome(tool("write_file").run(ctx(), { path: file, content: "hi\n" }))).toBe("ran");
    expect(await readFile(file, "utf8")).toBe("hi\n");
  });

  it("takes an edit to an existing file with no change approval", async () => {
    const file = path.join(worktree, "edit.txt");
    await mkdir(worktree, { recursive: true });
    await writeFile(file, "one\ntwo\n");
    await read(file);
    expect(await outcome(tool("edit_file").run(ctx(), { path: file, old_text: "two", new_text: "2" }))).toBe("ran");
    expect(await readFile(file, "utf8")).toBe("one\n2\n");
  });

  it("is read with no access prompt", async () => {
    const file = path.join(worktree, "read.txt");
    await mkdir(worktree, { recursive: true });
    await writeFile(file, "x\n");
    expect(await outcome(read(file))).toBe("ran");
  });
});

describe("the rest of ~/.llama-mui", () => {
  it("asks for access to a session's chat file, to read it or to replace it", async () => {
    await mkdir(session, { recursive: true });
    await writeFile(chatFile, "{}\n");
    expect(await outcome(read(chatFile))).toBe("asked for access");
    expect(await outcome(write(chatFile))).toBe("asked for access");
  });

  it("asks for access to a new file directly in a session's folder or in sessions", async () => {
    expect(await outcome(write(path.join(session, "plan.json")))).toBe("asked for access");
    expect(await outcome(write(path.join(sessionsDir, "x.txt")))).toBe("asked for access");
  });

  it("asks for access to a folder whose name only starts with worktrees", async () => {
    expect(await outcome(write(path.join(session, "worktrees-old", "a.txt")))).toBe("asked for access");
  });

  it("asks for access to a new file in ~/.llama-mui outside sessions", async () => {
    expect(await outcome(write(path.join(home.dir, ".llama-mui", "audit", "a.log")))).toBe("asked for access");
  });

  it("asks for access when a .. segment leads from a worktree to the chat file", async () => {
    await mkdir(worktree, { recursive: true });
    const sneaky = path.join(worktree, "nope", "..", "..", "..", "chat.json");
    expect(await outcome(write(sneaky))).toBe("asked for access");
    expect(await outcome(read(sneaky))).toBe("asked for access");
  });

  it("asks for access to the chat file through a symlink in a worktree", async () => {
    await mkdir(worktree, { recursive: true });
    await writeFile(chatFile, "{}\n");
    const link = path.join(worktree, "history.json");
    await symlink(chatFile, link);
    expect(await outcome(read(link))).toBe("asked for access");
    expect(await outcome(write(link))).toBe("asked for access");
  });
});

describe("an attached folder outside sessions", () => {
  it("still asks for approval to write", async () => {
    const dir = path.join(home.dir, "project");
    await mkdir(dir, { recursive: true });
    const file = path.join(await realpath(dir), "a.txt");
    expect(await outcome(tool("write_file").run(ctx([dir]), { path: file, content: "x\n" }))).toBe("asked for approval");
  });
});

describe("inSessionWorktrees", () => {
  it.each([
    [path.join(session, "worktrees"), true],
    [path.join(worktree, "a", "b"), true],
    [session, false],
    [chatFile, false],
    [sessionsDir, false],
    [path.join(session, "worktrees-old", "a"), false],
    [path.join(`${sessionsDir}-other`, "abc", "worktrees", "a"), false],
    [path.join(home.dir, "worktrees", "a"), false],
  ])("for %s is %s", async (real, expected) => {
    expect(await inSessionWorktrees(real)).toBe(expected);
  });
});
