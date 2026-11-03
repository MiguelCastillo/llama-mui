import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

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
const hub = await import("../runHub.ts");

const sessionFile = (id: string) => path.join(home.dir, ".llama-mui", "sessions", id, "session.json");
const onDisk = async (id: string) => JSON.parse(await readFile(sessionFile(id), "utf8"));

// Answers the way the plugin does: an HttpError's extra fields sit next to `error`.
const call = async (method: string, parts: string[], body?: unknown) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  try {
    await sessionRoutes({ req, res, parts: ["sessions", ...parts], method, search: "" });
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { ...e.extra, error: e.message } as any };
    throw e;
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : null } as { status: number; body: any };
};

const chat = (id: string, extra: object = {}) => ({ id, title: "Chat", messages: [{ role: "user", content: "hi" }], ...extra });

// A run that keeps its session in memory, as the server's runner will.
const fakeRun = (live: any) => ({ session: () => live });

describe("revisions", () => {
  it("counts every server write, and tells the page in each answer", async () => {
    const first = await call("PUT", ["rev-a"], chat("rev-a"));
    expect(first.body.revision).toBe(1);
    expect((await onDisk("rev-a")).revision).toBe(1);
    const second = await call("PUT", ["rev-a"], chat("rev-a", { revision: 1 }));
    expect(second.body.revision).toBe(2);
    const renamed = await call("PATCH", ["rev-a"], { title: "Mine", userName: "Mine" });
    expect(renamed.body).toMatchObject({ title: "Mine", revision: 3 });
    expect((await call("GET", ["rev-a"])).body.revision).toBe(3);
  });

  it("reads a session saved before revisions as revision 0", async () => {
    await mkdir(path.dirname(sessionFile("rev-old")), { recursive: true });
    await writeFile(sessionFile("rev-old"), JSON.stringify({ ...chat("rev-old"), title: "Old", updatedAt: 1 }));
    expect((await call("GET", ["rev-old"])).body.revision).toBe(0);
    expect((await call("PUT", ["rev-old"], chat("rev-old", { revision: 0 }))).body.revision).toBe(1);
  });

  it("refuses a save made from an older revision, says the current one, and writes nothing", async () => {
    await call("PUT", ["rev-b"], chat("rev-b"));
    await call("PUT", ["rev-b"], chat("rev-b", { revision: 1, title: "Newer" }));
    const stale = await call("PUT", ["rev-b"], chat("rev-b", { revision: 1, messages: [{ role: "user", content: "stale" }] }));
    expect(stale.status).toBe(409);
    expect(stale.body.revision).toBe(2);
    expect(stale.body.error).toMatch(/changed somewhere else/);
    expect((await onDisk("rev-b")).messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("still takes a save that sends no revision, as an older client does", async () => {
    await call("PUT", ["rev-c"], chat("rev-c"));
    await call("PUT", ["rev-c"], chat("rev-c"));
    const third = await call("PUT", ["rev-c"], chat("rev-c", { title: "Again" }));
    expect(third.status).toBe(200);
    expect(third.body.revision).toBe(3);
  });

  it("lets only one of two saves from the same revision through", async () => {
    await call("PUT", ["rev-d"], chat("rev-d"));
    const [a, b] = await Promise.all([
      call("PUT", ["rev-d"], chat("rev-d", { revision: 1 })),
      call("PUT", ["rev-d"], chat("rev-d", { revision: 1 })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await onDisk("rev-d")).revision).toBe(2);
  });

  it("takes the revision and run record from the server, not from the page's copy", async () => {
    const put = await call("PUT", ["rev-e"], chat("rev-e", { run: { status: "running", startedAt: 1 } }));
    expect(put.body.revision).toBe(1);
    expect((await onDisk("rev-e")).run).toBeUndefined();
    const bad = await call("PUT", ["rev-e"], chat("rev-e", { revision: "x" }));
    expect(bad.status).toBe(400);
  });
});

describe("a session with a run in progress", () => {
  it("refuses the page's saves, with or without a revision, and accepts them once the run ends", async () => {
    await call("PUT", ["run-a"], chat("run-a"));
    await hub.beginRun("run-a");
    const withRevision = await call("PUT", ["run-a"], chat("run-a", { revision: 2 }));
    const without = await call("PUT", ["run-a"], chat("run-a", { messages: [{ role: "user", content: "page copy" }] }));
    expect([withRevision.status, without.status]).toEqual([409, 409]);
    expect(without.body.error).toMatch(/plan is running/);
    expect((await onDisk("run-a")).messages).toEqual([{ role: "user", content: "hi" }]);

    await hub.endRun("run-a");
    const after = await call("GET", ["run-a"]);
    const saved = await call("PUT", ["run-a"], { ...after.body, title: "Later" });
    expect(saved.status).toBe(200);
  });

  it("keeps a page's old revision stale across the run, since the run's writes count", async () => {
    await call("PUT", ["run-b"], chat("run-b"));
    await hub.beginRun("run-b");
    await hub.save("run-b", chat("run-b", { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "done" }] }));
    await hub.endRun("run-b");
    const stale = await call("PUT", ["run-b"], chat("run-b", { revision: 1 }));
    expect(stale.status).toBe(409);
    expect(stale.body.revision).toBe(await onDisk("run-b").then((s) => s.revision));
    expect((await onDisk("run-b")).messages).toHaveLength(2);
  });

  it("writes a plain run record into session.json while live, and removes it at the end", async () => {
    await call("PUT", ["run-c"], chat("run-c"));
    await hub.beginRun("run-c");
    expect((await onDisk("run-c")).run).toMatchObject({ status: "running", startedAt: expect.any(Number) });
    await hub.updateRun("run-c", { status: "waiting", ask: { id: "a1", kind: "approval", details: { tool: "write_file" } } });
    expect((await onDisk("run-c")).run).toMatchObject({ status: "waiting", ask: { id: "a1", kind: "approval" } });
    await hub.updateRun("run-c", { status: "running", ask: null });
    expect((await onDisk("run-c")).run.ask).toBeUndefined();
    await hub.endRun("run-c");
    expect((await onDisk("run-c")).run).toBeUndefined();
    expect(hub.liveRun("run-c")).toBeNull();
  });

  it("is not blocked by a stale run record in session.json, which only a live run blocks", async () => {
    await mkdir(path.dirname(sessionFile("run-d")), { recursive: true });
    await writeFile(sessionFile("run-d"), JSON.stringify({ ...chat("run-d"), updatedAt: 1, run: { status: "running", startedAt: 5 } }));
    expect(hub.liveRun("run-d")).toBeNull();
    const put = await call("PUT", ["run-d"], chat("run-d", { title: "Saved anyway" }));
    expect(put.status).toBe(200);
    expect((await onDisk("run-d")).run).toEqual({ status: "running", startedAt: 5 }); // left for a restart to find
  });

  it("won't start the same session's run twice", async () => {
    await call("PUT", ["run-e"], chat("run-e"));
    await hub.beginRun("run-e");
    const second = await hub.beginRun("run-e").catch((e) => e);
    expect(second).toBeInstanceOf(HttpError);
    expect(second.status).toBe(409);
    expect(second.extra.reason).toBe("already running");
    await hub.endRun("run-e");
    await expect(hub.beginRun("run-e")).resolves.toMatchObject({ status: "running" });
    await hub.endRun("run-e");
  });

  it("won't start a run for a session that isn't saved", async () => {
    const e = await hub.beginRun("run-nothing").catch((x) => x);
    expect(e.status).toBe(404);
    expect(hub.liveRun("run-nothing")).toBeNull();
  });

  it("sends a rename through the run's live session, so the run's next save keeps it", async () => {
    await call("PUT", ["run-f"], chat("run-f"));
    const live: any = { ...chat("run-f"), title: "Chat", userName: null, modelName: null, plan: { steps: [] } };
    await hub.beginRun("run-f", fakeRun(live));
    const patch = await call("PATCH", ["run-f"], { title: "Renamed", userName: "Renamed" });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ title: "Renamed" });
    expect(live).toMatchObject({ title: "Renamed", userName: "Renamed" });
    // The run saves its own copy later, and the name is still there.
    await hub.save("run-f", live);
    const file = await onDisk("run-f");
    expect(file).toMatchObject({ title: "Renamed", userName: "Renamed", plan: { steps: [] } });
    expect(file.run.status).toBe("running");
    await hub.endRun("run-f");
  });

  it("refuses to delete a session while it runs", async () => {
    await call("PUT", ["run-g"], chat("run-g"));
    await hub.beginRun("run-g");
    const del = await call("DELETE", ["run-g"]);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/Stop it first/);
    await hub.endRun("run-g");
    expect((await call("DELETE", ["run-g"])).status).toBe(200);
  });

  it("keeps the run's state to plain data: no functions, nothing the page's copy added", async () => {
    await call("PUT", ["run-h"], chat("run-h"));
    await hub.beginRun("run-h", fakeRun({ ...chat("run-h") }));
    await hub.updateRun("run-h", { status: "paused" });
    const state = hub.liveRun("run-h")!;
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    state.status = "stopped"; // a copy: changing it changes nothing in the hub
    expect(hub.liveRun("run-h")!.status).toBe("paused");
    await hub.endRun("run-h");
  });
});

describe("events", () => {
  it("tells listeners about status, ask, saved and removed, in order", async () => {
    await call("PUT", ["ev-a"], chat("ev-a"));
    const seen: string[] = [];
    const stop = hub.subscribe((e) => {
      if (e.id === "ev-a") seen.push(e.type + (e.type === "status" ? `:${(e.data.run as any)?.status ?? "none"}` : ""));
    });
    await hub.beginRun("ev-a");
    await hub.updateRun("ev-a", { status: "waiting", ask: { id: "q", kind: "location", details: {} } });
    await hub.endRun("ev-a");
    await call("DELETE", ["ev-a"]);
    stop();
    expect(seen).toEqual([
      "saved", "status:running",
      "saved", "status:waiting", "ask",
      "saved", "status:none",
      "removed",
    ]);
  });

  it("carries the summary row and revision in `saved`, and no messages", async () => {
    const events: any[] = [];
    const stop = hub.subscribe((e) => void (e.id === "ev-b" && events.push(e)));
    await call("PUT", ["ev-b"], chat("ev-b", { parentId: "ev-a" }));
    stop();
    expect(events).toHaveLength(1);
    expect(events[0].data.revision).toBe(1);
    expect(events[0].data.summary).toMatchObject({ id: "ev-b", parentId: "ev-a" });
    expect(JSON.stringify(events[0])).not.toContain("messages");
  });

  it("is not stopped by a listener that throws", async () => {
    await call("PUT", ["ev-c"], chat("ev-c"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = hub.subscribe(() => {
      throw new Error("bad listener");
    });
    const put = await call("PUT", ["ev-c"], chat("ev-c"));
    stop();
    warn.mockRestore();
    expect(put.status).toBe(200);
  });
});
