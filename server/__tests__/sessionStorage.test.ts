import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { HttpError } = await import("../http.ts");
const { sessionRoutes } = await import("../sessions.ts");

const oldDir = () => path.join(home.dir, ".llama-mui", "chats");
const sessionsDir = () => path.join(home.dir, ".llama-mui", "sessions");
const sessionFile = (id: string) => path.join(sessionsDir(), id, "session.json");
const exists = (p: string) => stat(p).then(() => true, () => false);

const call = async (method: string, parts: string[], body?: unknown) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  try {
    await sessionRoutes({ req, res, parts: ["sessions", ...parts], method, search: "" });
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: null };
    throw e;
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : null };
};

const saved = (id: string, extra: object = {}) => ({
  id,
  title: `Title ${id}`,
  updatedAt: 1,
  createdAt: 1,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

// Old chat files exist before the first request, which is what moves them.
beforeAll(async () => {
  await mkdir(oldDir(), { recursive: true });
  await writeFile(path.join(oldDir(), "old-one.json"), JSON.stringify(saved("old-one", { updatedAt: 50 })));
  await writeFile(path.join(oldDir(), "wrong-name.json"), JSON.stringify(saved("another-id")));
  await writeFile(path.join(oldDir(), "broken.json"), "{ not json");
  await writeFile(path.join(oldDir(), "dup.json"), JSON.stringify(saved("dup", { title: "old copy" })));
  await mkdir(path.join(sessionsDir(), "dup"), { recursive: true });
  await writeFile(sessionFile("dup"), JSON.stringify(saved("dup", { title: "new copy", updatedAt: 60 })));
});

describe("moving old chat files into sessions", () => {
  it("lists a chat file from the old folder, now stored as sessions/<id>/session.json", async () => {
    const { body } = await call("GET", []);
    expect(body.map((s: any) => s.id)).toContain("old-one");
    expect(JSON.parse(await readFile(sessionFile("old-one"), "utf8")).title).toBe("Title old-one");
    expect(await exists(path.join(oldDir(), "old-one.json"))).toBe(false);
  });

  it("leaves a file whose id is not its name, a file that is not JSON, and a file whose session already exists", async () => {
    expect((await readdir(oldDir())).sort()).toEqual(["broken.json", "dup.json", "wrong-name.json"]);
    expect(JSON.parse(await readFile(sessionFile("dup"), "utf8")).title).toBe("new copy");
  });
});

describe("session routes", () => {
  it("saves with PUT in the session's folder and reads it back with GET", async () => {
    const put = await call("PUT", ["abc"], saved("abc", { title: "Mine" }));
    expect(put.status).toBe(200);
    expect(JSON.parse(await readFile(sessionFile("abc"), "utf8")).title).toBe("Mine");
    expect((await call("GET", ["abc"])).body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("lists newest first and skips a folder that has no session.json", async () => {
    await mkdir(path.join(sessionsDir(), "only-worktrees", "worktrees"), { recursive: true });
    const ids = (await call("GET", [])).body.map((s: any) => s.id);
    expect(ids[0]).toBe("abc");
    expect(ids).not.toContain("only-worktrees");
  });

  it("refuses an id that is not a plain id", async () => {
    expect((await call("PUT", ["..%2Fx"], saved("x"))).status).toBe(400);
    expect((await call("GET", ["A_B"])).status).toBe(400);
  });

  it("deletes session.json and its empty folder", async () => {
    await call("PUT", ["gone"], saved("gone"));
    expect((await call("DELETE", ["gone"])).status).toBe(200);
    expect(await exists(path.join(sessionsDir(), "gone"))).toBe(false);
  });

  it("deletes session.json but keeps a worktree in the folder", async () => {
    await call("PUT", ["keeps"], saved("keeps"));
    const work = path.join(sessionsDir(), "keeps", "worktrees", "feature", "a.txt");
    await mkdir(path.dirname(work), { recursive: true });
    await writeFile(work, "work\n");
    await call("DELETE", ["keeps"]);
    expect(await exists(sessionFile("keeps"))).toBe(false);
    expect(await readFile(work, "utf8")).toBe("work\n");
  });
});
