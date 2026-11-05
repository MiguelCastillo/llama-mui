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
const { convertWorkingDir } = await import("../sessionFile.ts");

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

  it("carries parentId in the list and in the PUT and PATCH answers, and null without one", async () => {
    const put = await call("PUT", ["child-1"], saved("child-1", { parentId: "abc" }));
    expect(put.body.parentId).toBe("abc");
    const patch = await call("PATCH", ["child-1"], { title: "Renamed", userName: "Renamed" });
    expect(patch.body).toMatchObject({ id: "child-1", title: "Renamed", parentId: "abc" });
    const list = (await call("GET", [])).body;
    expect(list.find((s: any) => s.id === "child-1").parentId).toBe("abc");
    expect(list.find((s: any) => s.id === "abc").parentId).toBeNull();
    expect((await call("PUT", ["plain-1"], saved("plain-1"))).body.parentId).toBeNull();
    expect((await call("PATCH", ["plain-1"], { userName: "X" })).body.parentId).toBeNull();
  });

  it("keeps a group set by PATCH through later saves, trims it, and clears it with null or empty", async () => {
    await call("PUT", ["grp-1"], saved("grp-1"));
    expect((await call("PATCH", ["grp-1"], { group: "  Work  " })).body.group).toBe("Work");
    // A save from a page that never knew the group doesn't wipe it.
    expect((await call("PUT", ["grp-1"], saved("grp-1"))).body.group).toBe("Work");
    expect((await call("GET", [])).body.find((s: any) => s.id === "grp-1").group).toBe("Work");
    expect((await call("PATCH", ["grp-1"], { group: "" })).body.group).toBeNull();
    await call("PATCH", ["grp-1"], { group: "Work" });
    expect((await call("PATCH", ["grp-1"], { group: null })).body.group).toBeNull();
    expect((await call("PUT", ["grp-2"], saved("grp-2"))).body.group).toBeNull();
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

  it("deletes a session together with every session nested under it", async () => {
    await call("PUT", ["fam-p"], saved("fam-p"));
    await call("PUT", ["fam-c"], saved("fam-c", { parentId: "fam-p" }));
    await call("PUT", ["fam-g"], saved("fam-g", { parentId: "fam-c" }));
    await call("PUT", ["fam-x"], saved("fam-x"));
    const del = await call("DELETE", ["fam-p"]);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ id: "fam-p", deleted: ["fam-g", "fam-c", "fam-p"] });
    for (const id of ["fam-p", "fam-c", "fam-g"]) expect(await exists(sessionFile(id))).toBe(false);
    expect(await exists(sessionFile("fam-x"))).toBe(true);
  });

  it("deleting a nested session leaves its parent and its siblings", async () => {
    await call("PUT", ["one-p"], saved("one-p"));
    await call("PUT", ["one-a"], saved("one-a", { parentId: "one-p" }));
    await call("PUT", ["one-b"], saved("one-b", { parentId: "one-p" }));
    expect((await call("DELETE", ["one-a"])).body).toEqual({ id: "one-a", deleted: ["one-a"] });
    expect(await exists(sessionFile("one-p"))).toBe(true);
    expect(await exists(sessionFile("one-b"))).toBe(true);
  });

  it("keeps the worktree of a nested session that is deleted with its parent", async () => {
    await call("PUT", ["wt-p"], saved("wt-p"));
    await call("PUT", ["wt-c"], saved("wt-c", { parentId: "wt-p" }));
    const work = path.join(sessionsDir(), "wt-c", "worktrees", "feature", "a.txt");
    await mkdir(path.dirname(work), { recursive: true });
    await writeFile(work, "work\n");
    await call("DELETE", ["wt-p"]);
    expect(await exists(sessionFile("wt-c"))).toBe(false);
    expect(await readFile(work, "utf8")).toBe("work\n");
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

const attach = (p: string, kind: "file" | "folder") => ({ path: p, kind, source: "manual" });

describe("a session saved before chats had a working directory", () => {
  it("takes the first folder as workingDir, removes it from the attachments and keeps the others in order", () => {
    const old = {
      id: "s",
      attachments: [attach("/a/file.txt", "file"), attach("/work/app", "folder"), attach("/work/other", "folder")],
    };
    const before = JSON.stringify(old);
    const converted = convertWorkingDir(old);
    expect(converted.workingDir).toBe("/work/app");
    expect(converted.attachments).toEqual([attach("/a/file.txt", "file"), attach("/work/other", "folder")]);
    expect(converted.id).toBe("s");
    // The old object is left alone: the conversion builds a new one.
    expect(JSON.stringify(old)).toBe(before);
  });

  it("takes a folder that comes first in the list, and nothing else changes in the list", () => {
    const converted = convertWorkingDir({ attachments: [attach("/work/app", "folder"), attach("/a/file.txt", "file")] });
    expect(converted.workingDir).toBe("/work/app");
    expect(converted.attachments).toEqual([attach("/a/file.txt", "file")]);
  });

  it("gets null when only files are attached, and keeps them", () => {
    const files = [attach("/a/one.txt", "file"), attach("/a/two.txt", "file")];
    expect(convertWorkingDir({ attachments: files })).toEqual({ attachments: files, workingDir: null });
  });

  it("gets null when nothing is attached, or the attachments are missing", () => {
    expect(convertWorkingDir({ attachments: [] })).toEqual({ attachments: [], workingDir: null });
    expect(convertWorkingDir({ id: "s" })).toEqual({ id: "s", workingDir: null });
  });

  it("leaves a session that has workingDir alone, null included, even with a folder attached", () => {
    const withDir = { workingDir: "/work/app", attachments: [attach("/work/other", "folder")] };
    expect(convertWorkingDir(withDir)).toBe(withDir);
    const withNull = { workingDir: null, attachments: [attach("/work/other", "folder")] };
    expect(convertWorkingDir(withNull)).toBe(withNull);
    expect(withNull.attachments).toEqual([attach("/work/other", "folder")]);
  });

  const writeOld = async (id: string) => {
    await mkdir(path.join(sessionsDir(), id), { recursive: true });
    await writeFile(
      sessionFile(id),
      JSON.stringify(saved(id, { attachments: [attach("/a/file.txt", "file"), attach("/work/app", "folder")] })),
    );
  };

  it("is converted when read, and the file is not rewritten by reading", async () => {
    await writeOld("wd-read");
    const { body } = await call("GET", ["wd-read"]);
    expect(body.workingDir).toBe("/work/app");
    expect(body.attachments).toEqual([attach("/a/file.txt", "file")]);
    expect(JSON.parse(await readFile(sessionFile("wd-read"), "utf8")).workingDir).toBeUndefined();
  });

  it("is saved with the conversion by the next save", async () => {
    await writeOld("wd-put");
    const { body } = await call("GET", ["wd-put"]);
    expect((await call("PUT", ["wd-put"], body)).status).toBe(200);
    const onDisk = JSON.parse(await readFile(sessionFile("wd-put"), "utf8"));
    expect(onDisk.workingDir).toBe("/work/app");
    expect(onDisk.attachments).toEqual([attach("/a/file.txt", "file")]);
  });

  it("is saved with the conversion by a rename too, which edits the file it read", async () => {
    await writeOld("wd-patch");
    expect((await call("PATCH", ["wd-patch"], { userName: "Renamed" })).status).toBe(200);
    const onDisk = JSON.parse(await readFile(sessionFile("wd-patch"), "utf8"));
    expect(onDisk.workingDir).toBe("/work/app");
    expect(onDisk.attachments).toEqual([attach("/a/file.txt", "file")]);
  });

  it("keeps a working directory that was cleared: no folder comes back from the attachments", async () => {
    await call("PUT", ["wd-cleared"], saved("wd-cleared", { workingDir: null, attachments: [attach("/work/other", "folder")] }));
    const { body } = await call("GET", ["wd-cleared"]);
    expect(body.workingDir).toBeNull();
    expect(body.attachments).toEqual([attach("/work/other", "folder")]);
  });
});

describe("replacing a chat's working directory", () => {
  const extra = [attach("/a/file.txt", "file"), attach("/docs", "folder")];

  it("leaves the attachments as they were, and the old folder is not kept as one", async () => {
    await call("PUT", ["wd-replace"], saved("wd-replace", { workingDir: "/work/old", attachments: extra }));
    const first = (await call("GET", ["wd-replace"])).body;
    expect(first.workingDir).toBe("/work/old");

    // What the page saves after choosing another folder.
    expect((await call("PUT", ["wd-replace"], { ...first, workingDir: "/work/new" })).status).toBe(200);
    const after = (await call("GET", ["wd-replace"])).body;
    expect(after.workingDir).toBe("/work/new");
    expect(after.attachments).toEqual(extra);
    expect(JSON.stringify(after)).not.toContain("/work/old");
    expect(JSON.stringify(JSON.parse(await readFile(sessionFile("wd-replace"), "utf8")))).not.toContain("/work/old");
  });

  it("clearing it leaves the attachments as they were too, and nothing takes its place", async () => {
    await call("PUT", ["wd-clear"], saved("wd-clear", { workingDir: "/work/old", attachments: extra }));
    const first = (await call("GET", ["wd-clear"])).body;
    expect((await call("PUT", ["wd-clear"], { ...first, workingDir: null })).status).toBe(200);
    const after = (await call("GET", ["wd-clear"])).body;
    expect(after.workingDir).toBeNull();
    // The attached folder is not promoted to a working directory by reading.
    expect(after.attachments).toEqual(extra);
  });
});

describe("the run record on GET", () => {
  it("shows a run that is live in this process, and hides a record a crash left in the file", async () => {
    const hub = await import("../runHub.ts");
    await call("PUT", ["with-run"], saved("with-run"));
    const onDisk = JSON.parse(await readFile(sessionFile("with-run"), "utf8"));
    await writeFile(sessionFile("with-run"), JSON.stringify({ ...onDisk, run: { status: "running", startedAt: 5 } }));
    expect((await call("GET", ["with-run"])).body.run).toBeUndefined();

    await hub.beginRun("with-run");
    expect((await call("GET", ["with-run"])).body.run).toMatchObject({ status: "running" });
    await hub.endRun("with-run");
    expect((await call("GET", ["with-run"])).body.run).toBeUndefined();
  });
});
