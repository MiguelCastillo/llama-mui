import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// sessions.ts reads the home folder when it loads; point it at a temp one.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const { openTodoList, sessionRoutes } = await import("../sessions.ts");

const todo = (id: unknown, summary: unknown, status = "open") => ({ id, summary, description: "d", status, createdAt: 1 });

describe("openTodoList", () => {
  it("is empty without the field", () => {
    expect(openTodoList(undefined)).toEqual([]);
    expect(openTodoList(null)).toEqual([]);
    expect(openTodoList("nope")).toEqual([]);
  });

  it("keeps open todos as id and summary, with no description", () => {
    expect(openTodoList([todo("a", "one"), todo("b", "two", "done"), todo("c", "three")])).toEqual([
      { id: "a", summary: "one" },
      { id: "c", summary: "three" },
    ]);
  });

  it("skips entries with no id or summary", () => {
    expect(openTodoList([todo(1, "x"), todo("a", 2), null, todo("b", "ok")])).toEqual([{ id: "b", summary: "ok" }]);
  });
});

describe("GET /api/sessions", () => {
  const call = async (method: string, parts: string[], body?: unknown) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    let text = "";
    const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
    await sessionRoutes({ req, res, parts: ["sessions", ...parts], method, search: "" });
    return JSON.parse(text);
  };

  it("lists each session's open todos, and [] when it has none", async () => {
    const base = { title: "t", messages: [{ role: "user", content: "hi" }] };
    await call("PUT", ["with-todos"], { ...base, todos: [todo("a", "one"), todo("b", "two", "done")] });
    await call("PUT", ["old-session"], base);
    const list = await call("GET", []);
    expect(list.find((s: any) => s.id === "with-todos").todos).toEqual([{ id: "a", summary: "one" }]);
    expect(list.find((s: any) => s.id === "old-session").todos).toEqual([]);
  });
});
