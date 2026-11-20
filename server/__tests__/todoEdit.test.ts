import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Home folder pointed at a temp one: these tests never touch the real ~/.llama-mui.
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
const { lockSession } = await import("../sessionFile.ts");
const { editTodo } = await import("../todoEdit.ts");

const todo = (id: string, summary: string, status = "open") => ({ id, summary, description: `about ${id}`, context: "c", status, createdAt: 5 });

describe("editTodo", () => {
  const list = [todo("a", "one"), todo("b", "two"), todo("c", "three", "done")];

  it("done changes only that todo's status", () => {
    const r = editTodo(list, "a", "done");
    expect(r).toEqual({ ok: true, todos: [{ ...list[0], status: "done" }, list[1], list[2]] });
  });

  it("remove deletes only that todo, in any status", () => {
    expect(editTodo(list, "b", "remove")).toMatchObject({ ok: true, todos: [list[0], list[2]] });
    expect(editTodo(list, "c", "remove")).toMatchObject({ ok: true, todos: [list[0], list[1]] });
  });

  it("doesn't change the list it was given", () => {
    const before = JSON.stringify(list);
    editTodo(list, "a", "done");
    editTodo(list, "a", "remove");
    expect(JSON.stringify(list)).toBe(before);
  });

  it("refuses an unknown todo and names the ones that exist", () => {
    const r = editTodo(list, "zzz", "done");
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect((r as any).error).toMatch(/zzz/);
    expect((r as any).error).toMatch(/a \("one", open\)/);
    expect((r as any).error).toMatch(/c \("three", done\)/);
  });

  it("says there are none when the chat has no todos", () => {
    expect((editTodo(undefined, "a", "done") as any).error).toMatch(/none/);
  });

  it("refuses an unknown action and names the ones that exist", () => {
    for (const bad of ["explode", "", undefined, 3]) {
      const r = editTodo(list, "a", bad);
      expect(r).toMatchObject({ ok: false, status: 400 });
      expect((r as any).error).toMatch(/done, remove, restore/);
    }
  });

  it("remove also says what it removed and where it stood", () => {
    expect(editTodo(list, "b", "remove")).toMatchObject({ removed: { todo: list[1], index: 1 } });
    expect(editTodo(list, "a", "done")).not.toHaveProperty("removed");
  });

  it("restore puts the todo back at its old place", () => {
    const rest = [list[0], list[2]];
    expect(editTodo(rest, "b", "restore", { todo: list[1], index: 1 })).toEqual({ ok: true, todos: list });
    expect(editTodo(rest, "b", "restore", { todo: list[1], index: 0 })).toMatchObject({ todos: [list[1], list[0], list[2]] });
  });

  it("restore keeps a far or odd index inside the list", () => {
    expect((editTodo(list, "z", "restore", { todo: todo("z", "new"), index: 99 }) as any).todos.at(-1).id).toBe("z");
    expect((editTodo(list, "z", "restore", { todo: todo("z", "new"), index: -4 }) as any).todos[0].id).toBe("z");
    expect((editTodo(list, "z", "restore", { todo: todo("z", "new") }) as any).todos.at(-1).id).toBe("z");
  });

  it("restore cannot duplicate a todo", () => {
    const r = editTodo(list, "a", "restore", { todo: list[0], index: 0 });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as any).error).toMatch(/already has a todo with id a/);
  });

  it("restore refuses a missing or mismatched todo", () => {
    expect(editTodo(list, "z", "restore", {})).toMatchObject({ ok: false, status: 400 });
    expect(editTodo(list, "z", "restore", { todo: todo("y", "other") })).toMatchObject({ ok: false, status: 400 });
    expect(editTodo(list, "z", "restore", { todo: { id: "z", summary: "s", status: "weird" } })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("POST /api/sessions/<id>/todos/<todoId>", () => {
  const file = (id: string) => path.join(home.dir, ".llama-mui", "sessions", id, "session.json");
  const read = async (id: string) => JSON.parse(await readFile(file(id), "utf8"));
  const seed = async (id: string, extra: object = {}) => {
    await mkdir(path.dirname(file(id)), { recursive: true });
    await writeFile(
      file(id),
      JSON.stringify({
        id,
        title: `Title ${id}`,
        updatedAt: 111,
        createdAt: 1,
        revision: 4,
        modelName: "m",
        messages: [{ role: "user", content: "hi" }],
        todos: [todo("a", "one"), todo("b", "two"), todo("c", "three", "done")],
        ...extra,
      }),
    );
  };
  const call = async (id: string, todoId: string, body: unknown) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    let text = "";
    const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
    try {
      await sessionRoutes({ req, res, parts: ["sessions", id, "todos", todoId], method: "POST", search: "" });
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } as any };
      throw e;
    }
    return { status: res.statusCode, body: text ? JSON.parse(text) : null };
  };

  it("done takes the todo off the open list and keeps it saved as done", async () => {
    await seed("s1");
    const r = await call("s1", "a", { action: "done" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: "s1", todos: [{ id: "b", summary: "two" }] });
    expect((await read("s1")).todos.map((t: any) => [t.id, t.status])).toEqual([["a", "done"], ["b", "open"], ["c", "done"]]);
  });

  it("remove deletes the todo from the file", async () => {
    await seed("s2");
    const r = await call("s2", "b", { action: "remove" });
    expect(r.body).toMatchObject({ id: "s2", todos: [{ id: "a", summary: "one" }] });
    expect((await read("s2")).todos.map((t: any) => t.id)).toEqual(["a", "c"]);
  });

  it("remove answers with the removed record, and restore puts it back where it was", async () => {
    await seed("s6");
    const before = (await read("s6")).todos;
    const gone = await call("s6", "b", { action: "remove" });
    expect(gone.body.removed).toEqual({ todo: before[1], index: 1 });
    const back = await call("s6", "b", { action: "restore", ...gone.body.removed });
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ id: "s6", todos: [{ id: "a", summary: "one" }, { id: "b", summary: "two" }] });
    expect((await read("s6")).todos).toEqual(before);
    expect((await read("s6")).updatedAt).toBe(111);
  });

  it("refuses a restore of a todo that exists, and writes nothing", async () => {
    await seed("s7");
    const before = await readFile(file("s7"), "utf8");
    const r = await call("s7", "a", { action: "restore", todo: todo("a", "one"), index: 0 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already has a todo with id a/);
    expect(await readFile(file("s7"), "utf8")).toBe(before);
  });

  it("leaves other todos, other fields and updatedAt alone", async () => {
    await seed("s3");
    await call("s3", "a", { action: "remove" });
    const s = await read("s3");
    expect(s.todos).toEqual([todo("b", "two"), todo("c", "three", "done")]);
    expect(s).toMatchObject({ title: "Title s3", updatedAt: 111, createdAt: 1, modelName: "m", messages: [{ role: "user", content: "hi" }] });
    expect(s.revision).toBe(5); // a write by the server, like a rename
  });

  it("refuses a bad action, todo id or chat, naming what exists, and writes nothing", async () => {
    await seed("s4");
    const before = await readFile(file("s4"), "utf8");
    const action = await call("s4", "a", { action: "explode" });
    expect(action.status).toBe(400);
    expect(action.body.error).toMatch(/done, remove, restore/);
    const missing = await call("s4", "nope", { action: "done" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/a \("one", open\)/);
    expect((await call("no-such-chat", "a", { action: "done" })).status).toBe(404);
    expect((await call("../evil", "a", { action: "done" })).status).toBe(400);
    expect(await readFile(file("s4"), "utf8")).toBe(before);
  });

  it("waits for a locked file and edits what it holds afterwards", async () => {
    await seed("s5");
    let answer: any = null;
    await lockSession("s5", async () => {
      const pending = call("s5", "a", { action: "done" }).then((r) => (answer = r));
      await new Promise((r) => setTimeout(r, 400));
      expect(answer).toBeNull(); // still waiting
      expect((await read("s5")).todos[0].status).toBe("open");
      // Someone else (another server) writes while the lock is held.
      const now = await read("s5");
      await writeFile(file("s5"), JSON.stringify({ ...now, title: "Renamed meanwhile", revision: 9 }));
      void pending;
    });
    await vi.waitFor(() => expect(answer).not.toBeNull(), { timeout: 5000 });
    expect(answer.status).toBe(200);
    const s = await read("s5");
    expect(s.title).toBe("Renamed meanwhile"); // not overwritten by an old copy
    expect(s.revision).toBe(10);
    expect(s.todos[0].status).toBe("done");
  });
});
