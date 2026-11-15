import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Home is a temp folder before any module loads (they read it at load time).
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { sessionRoutes } = await import("../sessions.ts");
const { noteSession, auditDir } = await import("../audit.ts");

const put = async (id: string, extra: object = {}) => {
  const dir = path.join(home.dir, ".llama-mui", "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "session.json"), JSON.stringify({ id, title: `Title of ${id}`, workingDir: "/work", messages: [], ...extra }));
};

const lines = async (event: string) => {
  const names = await readdir(auditDir()).catch(() => [] as string[]);
  const all = (await Promise.all(names.map((n) => readFile(path.join(auditDir(), n), "utf8")))).flatMap((t) => t.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  return all.filter((l) => l.event === event);
};

const del = async (id: string) => {
  const req = Readable.from([]) as unknown as IncomingMessage;
  const res = { statusCode: 200, setHeader() {}, end() {} } as unknown as ServerResponse;
  await sessionRoutes({ req, res, parts: ["sessions", id], method: "DELETE", search: "" });
};

describe("session.seen", () => {
  it("is written once, the first time a session is named, with its title, folder and parent", async () => {
    await put("seen-a", { parentId: "seen-p" });
    noteSession("seen-a");
    noteSession("seen-a");
    noteSession("seen-a:thread");
    const got = (await lines("session.seen")).filter((l) => l.session === "seen-a");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ title: "Title of seen-a", workingDir: "/work", parent: "seen-p" });
  });

  it("is not written for a session with no file, nor for a bad id", async () => {
    noteSession("seen-none");
    noteSession("../x");
    noteSession(undefined);
    expect((await lines("session.seen")).filter((l) => l.session === "seen-none")).toHaveLength(0);
  });
});

describe("session.deleted", () => {
  it("keeps the title and family in the log after the file is gone", async () => {
    await put("del-p", { title: "Parent chat" });
    await put("del-c", { title: "Child chat", parentId: "del-p" });
    await del("del-p");
    await expect(readFile(path.join(home.dir, ".llama-mui", "sessions", "del-p", "session.json"))).rejects.toThrow();
    const got = await lines("session.deleted");
    const parent = got.find((l) => l.session === "del-p");
    const child = got.find((l) => l.session === "del-c");
    expect(parent).toMatchObject({ title: "Parent chat", workingDir: "/work", parent: null, family: ["del-c", "del-p"] });
    expect(child).toMatchObject({ title: "Child chat", parent: "del-p" });
    // A deleted session is not announced afterwards.
    noteSession("del-p");
    expect((await lines("session.seen")).filter((l) => l.session === "del-p")).toHaveLength(0);
  });
});
