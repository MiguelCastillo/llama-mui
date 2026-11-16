import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
const { publish, beginRun } = await import("../runHub.ts");
const { ownerNow } = await import("../runRecord.ts");

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const r = { req, res, parts: url.pathname.split("/").filter(Boolean).slice(1), method: req.method ?? "GET", search: url.search };
    (async () => (await eventRoutes(r, 1000)) || (await sessionRoutes(r)))().catch((e) => {
      sendJson(res, e instanceof HttpError ? e.status : 500, { error: e.message });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function collect() {
  const ctl = new AbortController();
  const res = await fetch(`${base}/events`, { signal: ctl.signal });
  const events: { type: string; data: any }[] = [];
  let buffer = "";
  const reader = res.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += new TextDecoder().decode(value);
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
  return { events, close: () => ctl.abort() };
}

describe("status events say who holds the floor", () => {
  it("another server's run carries holder.mine false and its port", async () => {
    const stream = await collect();
    const other = { status: "running", startedAt: 1, owner: { ...ownerNow(5175), serverId: "someone-else" } };
    publish({ type: "status", id: "h-a", data: { run: other } });
    await vi.waitFor(() => expect(stream.events.some((e) => e.type === "status")).toBe(true));
    const e = stream.events.find((x) => x.type === "status")!;
    expect(e.data.holder).toMatchObject({ port: 5175, mine: false });
    stream.close();
  });

  it("this server's own run is mine, and an ended run carries no holder", async () => {
    const stream = await collect();
    await fetch(`${base}/sessions/h-b`, { method: "PUT", body: JSON.stringify({ id: "h-b", title: "x", messages: [] }) });
    await beginRun("h-b", { session: () => ({ id: "h-b", title: "x", messages: [] }) as any });
    await vi.waitFor(() => expect(stream.events.some((e) => e.type === "status" && e.data.id === "h-b")).toBe(true));
    const own = stream.events.find((e) => e.type === "status" && e.data.id === "h-b")!;
    expect(own.data.holder).toMatchObject({ mine: true });
    publish({ type: "status", id: "h-b", data: { run: null } });
    await vi.waitFor(() => expect(stream.events.some((e) => e.data.id === "h-b" && e.data.run === null)).toBe(true));
    expect(stream.events.find((e) => e.data.id === "h-b" && e.data.run === null)!.data.holder).toBeUndefined();
    stream.close();
  });
});
