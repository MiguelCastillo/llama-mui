import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The home folder is pointed at a temp one first: never the real ~/.llama-mui.
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
const { fileRunStore } = await import("../runRecord.ts");
const hub = await import("../runHub.ts");

let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const r = { req, res, parts: url.pathname.split("/").filter(Boolean).slice(1), method: req.method ?? "GET", search: url.search };
    (async () => (await eventRoutes(r, 1000, 50)) || (await sessionRoutes(r)))().catch((e) => {
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

const plan = [
  { id: "1", status: "pending" },
  { id: "2", status: "pending" },
];
const put = (id: string, session: object = {}) =>
  fetch(`${base}/sessions/${id}`, { method: "PUT", body: JSON.stringify({ id, title: "Chat", messages: [], plan, ...session }) });
const get = async (id: string) => {
  const r = await fetch(`${base}/sessions/${id}`);
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
};

// A run record written by another server that checked in just now.
const otherServer = () => ({
  status: "running",
  startedAt: Date.now(),
  owner: { pid: process.pid, port: 5999, checkedAt: Date.now(), serverId: "another-server" },
});

async function firstEvents(path: string, count: number) {
  const ctl = new AbortController();
  const res = await fetch(`${base}${path}`, { signal: ctl.signal });
  const events: { type: string; data: any }[] = [];
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
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  await vi.waitFor(() => {
    if (events.length < count) throw new Error(`only ${events.length} events`);
  });
  return { events, close: () => ctl.abort() };
}

describe("the list of actions in the answer for opening a session", () => {
  it("lists only takeOver when another server runs it", async () => {
    await put("a-other");
    await fileRunStore.write("a-other", otherServer());
    const body = await get("a-other");
    expect(body.holder).toMatchObject({ port: 5999, mine: false });
    expect(body.actions).toEqual(["takeOver"]);
  });

  it("lists the idle actions when nobody runs it", async () => {
    await put("a-idle");
    const { actions } = await get("a-idle");
    expect(actions).toEqual(expect.arrayContaining(["run", "discard", "edit"]));
    expect(actions).not.toContain("takeOver");
    expect(actions).not.toContain("pause");
  });
});

describe("a run owned by another server", () => {
  it("sends a new list when its owner goes quiet, and when its steps change, without a reload", async () => {
    await put("p-other");
    await fileRunStore.write("p-other", otherServer());
    const stream = await firstEvents("/sessions/p-other/events", 1);
    expect(stream.events[0].data.actions).toEqual(["takeOver"]);

    // Its last check-in is now older than the owner may be: it counts as dead.
    await fileRunStore.update("p-other", (run: any) => void (run.owner.checkedAt = Date.now() - 60_000));
    await vi.waitFor(() => expect(stream.events.filter((e) => e.type === "status")).toHaveLength(1));
    const dead = stream.events.find((e) => e.type === "status")!;
    expect(dead.data.run).toBeNull();
    expect(dead.data.actions).toEqual(expect.arrayContaining(["run", "discard", "edit"]));
    expect(dead.data.actions).not.toContain("takeOver");

    // Quiet while nothing changes.
    await new Promise((r) => setTimeout(r, 200));
    expect(stream.events.filter((e) => e.type === "status")).toHaveLength(1);
    stream.close();
  });
});

describe("the list of actions in the session's event stream", () => {
  it("is in the snapshot", async () => {
    await put("e-idle");
    const stream = await firstEvents("/sessions/e-idle/events", 1);
    expect(stream.events[0].type).toBe("snapshot");
    expect(stream.events[0].data.actions).toEqual(expect.arrayContaining(["run", "discard", "edit"]));
    stream.close();

    await put("e-other");
    await fileRunStore.write("e-other", otherServer());
    const other = await firstEvents("/sessions/e-other/events", 1);
    expect(other.events[0].data.actions).toEqual(["takeOver"]);
    other.close();
  });

  it("is in each status event, worked out when it happens", async () => {
    await put("e-run");
    const stream = await firstEvents("/sessions/e-run/events", 1);
    await hub.beginRun("e-run", { session: () => ({ id: "e-run", title: "Chat", messages: [], plan }) as any });
    await vi.waitFor(() => expect(stream.events.some((e) => e.type === "status")).toBe(true));
    const started = stream.events.find((e) => e.type === "status")!;
    expect(started.data.actions).toEqual(expect.arrayContaining(["pause"]));
    expect(started.data.actions).not.toContain("discard");

    await hub.endRun("e-run");
    await vi.waitFor(() => expect(stream.events.filter((e) => e.type === "status" && e.data.run === null)).toHaveLength(1));
    const ended = stream.events.filter((e) => e.type === "status").pop()!;
    expect(ended.data.actions).toEqual(expect.arrayContaining(["run", "discard", "edit"]));
    expect(ended.data.actions).not.toContain("pause");
    stream.close();
  });
});
