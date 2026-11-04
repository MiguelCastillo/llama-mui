import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const { HttpError, sendJson } = await import("../http.ts");
const { eventRoutes } = await import("../events.ts");
const { sessionRoutes } = await import("../sessions.ts");
const hub = await import("../runHub.ts");

// A real server with the two routes, so the stream is read the way a browser
// reads it: over a socket, as it arrives.
let server: http.Server;
let base = "";
const HEARTBEAT = 40;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const r = { req, res, parts: url.pathname.split("/").filter(Boolean).slice(1), method: req.method ?? "GET", search: url.search };
    (async () => (await eventRoutes(r, HEARTBEAT)) || (await sessionRoutes(r)))().catch((e) => {
      sendJson(res, e instanceof HttpError ? e.status : 500, { ...(e instanceof HttpError ? e.extra : {}), error: e.message });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

interface Ev {
  type: string;
  data: any;
}

// Opens a stream and collects what comes: events by type, and the comment lines.
async function listen(path: string) {
  const ctl = new AbortController();
  const res = await fetch(`${base}${path}`, { signal: ctl.signal });
  const events: Ev[] = [];
  const comments: string[] = [];
  let buffer = "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end; (end = buffer.indexOf("\n\n")) >= 0; ) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(":")) comments.push(block);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  const until = (pred: (events: Ev[]) => boolean) =>
    vi.waitFor(() => {
      if (!pred(events)) throw new Error(`not yet: ${events.map((e) => e.type).join(",")}`);
    });
  return { res, events, comments, until, close: () => ctl.abort() };
}

const put = (id: string, session: object) =>
  fetch(`${base}/sessions/${id}`, { method: "PUT", body: JSON.stringify({ id, title: "Chat", messages: [], ...session }) });
const types = (events: Ev[]) => events.map((e) => e.type);

describe("GET /api/sessions/<id>/events", () => {
  it("starts with a snapshot of the session, its revision and its run, then follows the run", async () => {
    await put("s-a", { messages: [{ role: "user", content: "hi" }] });
    const live: any = { id: "s-a", title: "Chat", messages: [{ role: "user", content: "hi" }], plan: [{ id: "1", status: "pending" }] };
    const stream = await listen("/sessions/s-a/events");
    expect(stream.res.headers.get("content-type")).toBe("text/event-stream");
    await stream.until((e) => e.length === 1);
    expect(stream.events[0].type).toBe("snapshot");
    expect(stream.events[0].data).toMatchObject({ id: "s-a", revision: 1, run: null, session: { messages: [{ content: "hi" }] } });
    expect(stream.events[0].data.session.revision).toBeUndefined(); // it travels beside the session

    await hub.beginRun("s-a", { session: () => live });
    await hub.updateRun("s-a", { status: "waiting", ask: { id: "q1", kind: "approval", details: { tool: "write_file" } } });
    live.plan[0].status = "running";
    live.messages.push({ role: "assistant", content: "Working" });
    hub.publish({ type: "step", id: "s-a", data: { step: "1", status: "running" } });
    hub.flushAnnounce("s-a");
    await hub.endRun("s-a");
    await stream.until((e) => e.some((x) => x.type === "status" && x.data.run === null));

    // Each save comes with a status or the run's end; the order is the order things happened.
    expect(types(stream.events).filter((t) => t !== "saved")).toEqual(["snapshot", "status", "status", "ask", "step", "session", "status"]);
    const status = stream.events.filter((e) => e.type === "status").map((e) => e.data.run?.status ?? null);
    expect(status).toEqual(["running", "waiting", null]);
    expect(stream.events.find((e) => e.type === "ask")!.data).toMatchObject({ id: "s-a", ask: { id: "q1", kind: "approval" } });
    const patch = stream.events.find((e) => e.type === "session")!.data.patch;
    expect(patch.fields).toEqual({ plan: [{ id: "1", status: "running" }] });
    expect(patch.messages).toEqual({ from: 1, items: [{ role: "assistant", content: "Working" }], length: 2 });
    stream.close();
  });

  it("gives a page that opens mid-run the run's own newer copy and its state", async () => {
    await put("s-b", { messages: [{ role: "user", content: "old" }] });
    const live: any = { id: "s-b", title: "Chat", messages: [{ role: "user", content: "old" }, { role: "assistant", content: "newer, not saved yet" }] };
    await hub.beginRun("s-b", { session: () => live });
    await hub.updateRun("s-b", { status: "waiting" });
    const stream = await listen("/sessions/s-b/events");
    await stream.until((e) => e.length >= 1);
    const snap = stream.events[0].data;
    expect(snap.run).toMatchObject({ status: "waiting" });
    expect(snap.session.messages).toHaveLength(2);
    expect(snap.revision).toBeGreaterThan(1);
    await hub.endRun("s-b");
    stream.close();
  });

  it("sends a stream of patches that rebuild the chat, and never the whole chat per change", async () => {
    await put("s-c", {});
    const live: any = { id: "s-c", title: "Chat", messages: [{ role: "user", content: "x".repeat(5000) }, { role: "assistant", content: "" }] };
    await hub.beginRun("s-c", { session: () => live });
    const stream = await listen("/sessions/s-c/events");
    await stream.until((e) => e.length >= 1);
    for (let i = 0; i < 20; i++) {
      live.messages[1].content += "word ";
      hub.announce("s-c"); // twenty pieces in a burst
    }
    await stream.until((e) => e.some((x) => x.type === "session"));
    await new Promise((r) => setTimeout(r, hub.SESSION_EVENT_MS * 2));
    await hub.endRun("s-c");
    const patches = stream.events.filter((e) => e.type === "session");
    expect(patches.length).toBeLessThanOrEqual(2); // coalesced, not one per piece
    for (const p of patches) expect(JSON.stringify(p)).not.toContain("xxxxx");
    stream.close();
  });

  it("answers 404 for a session that isn't saved and 400 for a bad id, with no stream", async () => {
    const missing = await fetch(`${base}/sessions/nothing-here/events`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/json/);
    expect((await fetch(`${base}/sessions/Bad_Id/events`)).status).toBe(400);
  });

  it("only reads: a POST to it is refused", async () => {
    expect((await fetch(`${base}/sessions/s-a/events`, { method: "POST" })).status).toBe(405);
  });

  it("sends a comment now and then so a quiet connection stays open, and lets go when the page leaves", async () => {
    await put("s-d", {});
    const before = hub.listenerCount();
    const stream = await listen("/sessions/s-d/events");
    await stream.until((e) => e.length >= 1);
    expect(hub.listenerCount()).toBe(before + 1);
    await vi.waitFor(() => expect(stream.comments.filter((c) => c.includes("heartbeat")).length).toBeGreaterThanOrEqual(2));
    stream.close();
    await vi.waitFor(() => expect(hub.listenerCount()).toBe(before));
  });

  it("does not carry another session's events", async () => {
    await put("s-e1", {});
    await put("s-e2", {});
    const stream = await listen("/sessions/s-e1/events");
    await stream.until((e) => e.length >= 1);
    await hub.beginRun("s-e2");
    await hub.endRun("s-e2");
    await put("s-e1", {});
    await stream.until((e) => e.some((x) => x.type === "saved"));
    expect(stream.events.every((e) => e.type === "snapshot" || e.data.id === "s-e1")).toBe(true);
    stream.close();
  });
});

describe("GET /api/events", () => {
  it("starts with the runs that are live, then passes on status, saved and removed only", async () => {
    await put("g-a", {});
    await put("g-b", {});
    await hub.beginRun("g-a");
    const stream = await listen("/events");
    await stream.until((e) => e.length >= 1);
    expect(stream.events[0].type).toBe("snapshot");
    expect(stream.events[0].data.runs).toEqual([{ id: "g-a", run: expect.objectContaining({ status: "running" }) }]);

    hub.publish({ type: "step", id: "g-a", data: { step: "1" } });
    hub.publish({ type: "session", id: "g-a", data: { patch: { fields: {}, removed: [] } } });
    hub.publish({ type: "ask", id: "g-a", data: { ask: null } });
    await hub.updateRun("g-a", { status: "waiting", ask: { id: "q", kind: "location", details: {} } });
    await put("g-b", { title: "Renamed" });
    await hub.endRun("g-a");
    await fetch(`${base}/sessions/g-b`, { method: "DELETE" });
    await stream.until((e) => e.some((x) => x.type === "removed"));

    expect(types(stream.events).filter((t) => t !== "saved")).toEqual(["snapshot", "status", "status", "removed"]);
    const saved = stream.events.filter((e) => e.type === "saved");
    expect(saved.length).toBeGreaterThanOrEqual(3);
    expect(saved.find((e) => e.data.id === "g-b")!.data).toMatchObject({ summary: { id: "g-b" }, revision: expect.any(Number) });
    // The pending question is in the run's state, which is what the list's dot needs.
    expect(stream.events.filter((e) => e.type === "status")[0].data.run.ask).toMatchObject({ id: "q", kind: "location" });
    for (const e of saved) expect(JSON.stringify(e)).not.toContain("messages");
    stream.close();
  });
});
