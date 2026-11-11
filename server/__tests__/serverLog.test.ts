import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The log goes under the home folder: point it at a temp one first, so these
// tests never write the real ~/.llama-mui/logs.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { load, save } = await import("../store.ts");
const { connectorRoutes } = await import("../connectors.ts");
const { usageReader } = await import("../upstreamLog.ts");

// A Messages API stream as Anthropic sends it: usage in message_start (the
// input side) and message_delta (the output so far; the last one is the total).
const MESSAGES_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-5-5","usage":{"input_tokens":12,"cache_read_input_tokens":60000,"cache_creation_input_tokens":3000,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":480}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");
const { errorFields, log, logHint, logsDir, pruneLogs } = await import("../log.ts");
const { checkOnce, resetWatch } = await import("../watch.ts");
const { HttpError } = await import("../http.ts");

const KEY = "sk-test-secret-0123456789";

const lines = async (): Promise<any[]> => {
  const names = await readdir(logsDir()).catch(() => [] as string[]);
  const out: any[] = [];
  for (const n of names.filter((n) => /^server-.*\.log$/.test(n)).sort()) {
    for (const l of (await readFile(path.join(logsDir(), n), "utf8")).split("\n")) if (l) out.push(JSON.parse(l));
  }
  return out;
};
const ended = async (id: string) => {
  let found: any;
  await vi.waitFor(async () => {
    found = (await lines()).find((l) => l.event === "upstream.end" && l.id === id);
    expect(found).toBeDefined();
  });
  return found;
};

// A stand-in for the model server, and llama-mui's proxy in front of it.
let llama: Server;
let front: Server;
let llamaUrl = "";
let frontUrl = "";

beforeAll(async () => {
  llama = createServer((req, res) => {
    if (req.url === "/v1/ok") {
      res.setHeader("Content-Type", "text/event-stream");
      res.end("data: hello\n\ndata: [DONE]\n\n");
    } else if (req.url === "/v1/messages") {
      // In three pieces that cut lines in half, as a network can.
      res.setHeader("Content-Type", "text/event-stream");
      const cuts = [70, 260];
      res.write(MESSAGES_STREAM.slice(0, cuts[0]));
      res.write(MESSAGES_STREAM.slice(cuts[0], cuts[1]));
      res.end(MESSAGES_STREAM.slice(cuts[1]));
    } else if (req.url === "/v1/breaks") {
      // A chunk, then the connection drops: what a model's process dying looks like from here.
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: hel\n\n");
      setTimeout(() => req.socket.destroy(), 30);
    } else if (req.url === "/v1/slow") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: one\n\n");
      // Never finishes: the test hangs up first.
    } else {
      res.statusCode = 404;
      res.end("no");
    }
  });
  await new Promise<void>((r) => llama.listen(0, "127.0.0.1", r));
  llamaUrl = `http://127.0.0.1:${(llama.address() as AddressInfo).port}`;

  front = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    connectorRoutes({ req, res, parts, method: req.method ?? "GET", search: url.search }).catch((e) => {
      res.statusCode = e instanceof HttpError ? e.status : 500;
      res.end(e.message);
    });
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  frontUrl = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;

  // A port nothing listens on (not 1: fetch refuses that one as a bad port).
  const spare = createServer();
  await new Promise<void>((r) => spare.listen(0, "127.0.0.1", r));
  const closedPort = (spare.address() as AddressInfo).port;
  await new Promise<void>((r) => spare.close(() => r()));

  await mkdir(home.dir, { recursive: true });
  await save({
    ...(await load()),
    connectors: [
      { id: "up", name: "Studio", url: llamaUrl, apiKey: KEY, kind: "llama", api: "openai" },
      { id: "gone", name: "Nowhere", url: `http://127.0.0.1:${closedPort}`, apiKey: "", kind: "llama", api: "openai" },
    ],
  });
});

afterAll(() => {
  llama.closeAllConnections();
  front.closeAllConnections();
  llama.close();
  front.close();
});

describe("log", () => {
  it("writes one JSON line per event in today's file, with the time and process", async () => {
    log("test.event", { a: 1, b: "two" });
    const l = (await lines()).find((x) => x.event === "test.event");
    expect(l).toMatchObject({ a: 1, b: "two", pid: process.pid });
    expect(new Date(l.t).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("says what an error's cause was, where Node's fetch keeps the real reason", () => {
    const e = Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    expect(errorFields(e)).toMatchObject({ error: "terminated", errorName: "TypeError", cause: "UND_ERR_SOCKET", causeMessage: "other side closed" });
  });

  it("tells where today's log is and the command to follow it", () => {
    const hint = logHint(new Date("2026-11-06T12:00:00Z"));
    const file = path.join(logsDir(), "server-2026-11-06.log");
    expect(hint).toContain(`llama-mui log: ${file}`);
    expect(hint).toContain(`tail -f ${file}`);
  });

  it("removes logs older than two weeks and keeps the rest", async () => {
    await mkdir(logsDir(), { recursive: true });
    await writeFile(path.join(logsDir(), "server-2001-01-01.log"), "{}\n");
    await writeFile(path.join(logsDir(), "notes.txt"), "mine");
    pruneLogs();
    const names = await readdir(logsDir());
    expect(names).not.toContain("server-2001-01-01.log");
    expect(names).toContain("notes.txt");
    expect(names.some((n) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(n))).toBe(true);
  });
});

describe("requests to a model server", () => {
  const post = (p: string, signal?: AbortSignal) => fetch(`${frontUrl}/c/up${p}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" }, signal });

  it("log a start and, when the reply is whole, an end that says done", async () => {
    const res = await post("/v1/ok");
    expect(await res.text()).toContain("[DONE]");
    const all = await lines();
    const start = all.filter((l) => l.event === "upstream.start").pop();
    expect(start).toMatchObject({ connector: "Studio", method: "POST", path: "/v1/ok", via: "server" });
    const end = await ended(start.id);
    expect(end).toMatchObject({ outcome: "done", status: 200, connector: "Studio", path: "/v1/ok" });
    expect(end.bytes).toBeGreaterThan(0);
    expect(end.ms).toBeGreaterThanOrEqual(0);
  });

  it("give a Messages API reply's model and token counts, and nothing of its text", async () => {
    await (await post("/v1/messages")).text();
    const start = (await lines()).filter((l) => l.event === "upstream.start" && l.path === "/v1/messages").pop();
    const end = await ended(start.id);
    expect(end).toMatchObject({
      outcome: "done",
      model: "claude-sonnet-5-5",
      tokens: { input: 12, cacheRead: 60000, cacheWrite: 3000, output: 480 },
    });
    expect(JSON.stringify(end)).not.toContain("Hello");
  });

  it("give no token counts for other paths", async () => {
    await (await post("/v1/ok")).text();
    const start = (await lines()).filter((l) => l.event === "upstream.start" && l.path === "/v1/ok").pop();
    const end = await ended(start.id);
    expect(end.tokens).toBeUndefined();
    expect(end.model).toBeUndefined();
  });

  it("say upstream-error, with the cause, when the model server's connection breaks mid-reply", async () => {
    const res = await post("/v1/breaks");
    await res.text().catch(() => {});
    const start = (await lines()).filter((l) => l.event === "upstream.start" && l.path === "/v1/breaks").pop();
    const end = await ended(start.id);
    expect(end.outcome).toBe("upstream-error");
    expect(end.bytes).toBeGreaterThan(0);
    expect(end.error).toBeTruthy();
    expect(typeof end.idleMs).toBe("number");
  });

  it("say client-closed when whoever asked hangs up, and don't call that the model server's fault", async () => {
    const stop = new AbortController();
    const res = await post("/v1/slow", stop.signal);
    const reader = res.body!.getReader();
    await reader.read();
    stop.abort();
    await reader.read().catch(() => {});
    const start = (await lines()).filter((l) => l.event === "upstream.start" && l.path === "/v1/slow").pop();
    const end = await ended(start.id);
    expect(end.outcome).toBe("client-closed");
  });

  it("say connect-failed, with why, when the model server can't be reached", async () => {
    const res = await fetch(`${frontUrl}/c/gone/v1/ok`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    const start = (await lines()).filter((l) => l.event === "upstream.start" && l.connector === "Nowhere").pop();
    const end = await ended(start.id);
    expect(end).toMatchObject({ outcome: "connect-failed", phase: "before-answer", connector: "Nowhere" });
    expect(end.cause).toBe("ECONNREFUSED");
  });

  it("leave out a quick GET that went fine, and keep the query and the key out of every line", async () => {
    await fetch(`${frontUrl}/c/up/v1/ok?secret=${KEY}`);
    await post(`/v1/ok?also=${KEY}`);
    const text = JSON.stringify(await lines());
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("secret=");
    expect(text).not.toContain("Bearer");
    expect((await lines()).filter((l) => l.event === "upstream.end" && l.method === "GET" && l.outcome === "done")).toHaveLength(0);
  });
});

describe("usageReader", () => {
  it("reads the counts however the stream is cut, one character at a time included", () => {
    const r = usageReader();
    for (const ch of MESSAGES_STREAM) r.feed(ch);
    expect(r.result()).toEqual({ model: "claude-sonnet-5-5", input: 12, cacheRead: 60000, cacheWrite: 3000, output: 480 });
  });

  it("gives nothing for a stream without usage", () => {
    const r = usageReader();
    r.feed("data: hello\n\ndata: [DONE]\n\n");
    expect(r.result()).toBeUndefined();
  });

  it("drops an over-long line rather than keeping it, and still reads the rest", () => {
    const r = usageReader();
    r.feed("data: " + "x".repeat(70 * 1024));
    r.feed("\n" + MESSAGES_STREAM);
    expect(r.result()?.output).toBe(480);
  });
});

describe("the watch on model servers", () => {
  const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const refuse = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  }) as unknown as typeof fetch;
  const conn = { id: "w1", name: "Watched", url: "http://x", apiKey: KEY, kind: "llama" as const, api: "openai" as const };
  const events = async () => (await lines()).filter((l) => l.connector === "Watched").map((l) => [l.event, l.from, l.to, l.cause]);

  it("writes a line only when something changed: down, up, and a model going from loaded to unloaded", async () => {
    resetWatch();
    let t = 1_000;
    const now = () => (t += 1_000);
    await checkOnce([conn], answer({ data: [{ id: "m1", status: { value: "loaded" } }, { id: "plain" }] }), now);
    await checkOnce([conn], answer({ data: [{ id: "m1", status: { value: "loaded" } }, { id: "plain" }] }), now);
    await checkOnce([conn], answer({ data: [{ id: "m1", status: { value: "unloaded", failed: true, exit_code: 139 } }, { id: "plain" }] }), now);
    await checkOnce([conn], refuse, now);
    await checkOnce([conn], refuse, now);
    await checkOnce([conn], answer({ data: [{ id: "m1", status: { value: "unloaded" } }] }), now);
    expect(await events()).toEqual([
      ["llama.watch", undefined, undefined, undefined],
      ["llama.model", "loaded", "unloaded", undefined],
      ["llama.down", undefined, undefined, "ECONNREFUSED"],
      ["llama.up", undefined, undefined, undefined],
    ]);
    const model = (await lines()).find((l) => l.event === "llama.model");
    expect(model).toMatchObject({ model: "m1", failed: true, exitCode: 139 });
    const up = (await lines()).find((l) => l.event === "llama.up" && l.connector === "Watched");
    expect(up.downForMs).toBeGreaterThan(0);
    expect(JSON.stringify(await lines())).not.toContain(KEY);
  });

  it("calls an error status down, and doesn't watch Anthropic's API", async () => {
    resetWatch();
    const seenUrls: string[] = [];
    const f = (async (url: string) => {
      seenUrls.push(url);
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;
    await checkOnce([{ ...conn, id: "w2", name: "Busy" }, { ...conn, id: "w3", name: "Claude", kind: "anthropic" as const }], f);
    expect(seenUrls).toEqual(["http://x/v1/models"]);
    expect((await lines()).find((l) => l.event === "llama.down" && l.connector === "Busy")).toMatchObject({ status: 503 });
  });
});
