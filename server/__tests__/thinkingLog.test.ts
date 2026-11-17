import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NARRATION_SIGNATURE, THINKING_SIGNATURE } from "../../src/__tests__/realSignatures";

// The log's count of thinking blocks the connection can't tell (see
// upstreamLog.ts). The home folder is a temp one, so the real logs stay alone.
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
const { logsDir } = await import("../log.ts");
const { usageReader } = await import("../upstreamLog.ts");
const { HttpError } = await import("../http.ts");

// Words that must never reach the log: they stand for the model's own text.
const SECRET = "the-model-thought-about-the-secret-plan";

// A Messages stream with three thinking blocks, each with words (SECRET) and a
// signature: a note for the user, reasoning, and one the reader can't make sense of.
const block = (index: number, signature: string) =>
  [
    `event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"thinking_delta","thinking":"${SECRET}"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"signature_delta","signature":"${signature}"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":${index}}\n\n`,
  ].join("");
const STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-5-5","usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
  block(0, NARRATION_SIGNATURE),
  block(1, THINKING_SIGNATURE),
  block(2, "garbage-that-is-not-a-signature"),
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const lines = async (): Promise<any[]> => {
  const names = await readdir(logsDir()).catch(() => [] as string[]);
  const out: any[] = [];
  for (const n of names.filter((n) => /^server-.*\.log$/.test(n)).sort()) {
    for (const l of (await readFile(path.join(logsDir(), n), "utf8")).split("\n")) if (l) out.push(JSON.parse(l));
  }
  return out;
};

let model: Server;
let front: Server;
let frontUrl = "";

beforeAll(async () => {
  model = createServer((req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    // Cut in odd places, as a network can.
    res.write(STREAM.slice(0, 333));
    res.end(STREAM.slice(333));
    req.resume();
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  front = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    connectorRoutes({ req, res, parts: u.pathname.split("/").filter(Boolean), method: req.method ?? "GET", search: u.search }).catch((e) => {
      res.statusCode = e instanceof HttpError ? e.status : 500;
      res.end(e.message);
    });
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  frontUrl = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  await save({
    ...(await load()),
    connectors: [
      { id: "claude", name: "Claude", url, apiKey: "k", kind: "anthropic" },
      { id: "local", name: "Local", url, apiKey: "", kind: "llama", api: "anthropic" },
    ],
  });
});

afterAll(() => {
  model.closeAllConnections();
  front.closeAllConnections();
  model.close();
  front.close();
});

// Sends one request and returns its upstream.end line.
async function send(connector: string, body: object) {
  const before = new Set((await lines()).filter((l) => l.event === "upstream.start").map((l) => l.id));
  const res = await fetch(`${frontUrl}/c/${connector}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await res.text();
  let end: any;
  await vi.waitFor(async () => {
    const all = await lines();
    const start = all.find((l) => l.event === "upstream.start" && !before.has(l.id) && l.connector === (connector === "claude" ? "Claude" : "Local"));
    end = start && all.find((l) => l.event === "upstream.end" && l.id === start.id);
    expect(end).toBeDefined();
  });
  return end;
}

describe("the log's count of thinking blocks it can't classify", () => {
  it("counts a Claude block the connection can't tell, and none of the others (summarized display)", async () => {
    const end = await send("claude", { model: "m", thinking: { type: "adaptive", display: "summarized" } });
    expect(end.thinkingUnclassified).toBe(1);
  });

  it("counts none when updates display was asked for: any text is a note", async () => {
    const end = await send("claude", { model: "m", thinking: { type: "adaptive", display: "updates" } });
    expect(end).not.toHaveProperty("thinkingUnclassified");
  });

  it("counts nothing for llama.cpp, which says its thinking is always reasoning", async () => {
    const end = await send("local", { model: "m" });
    expect(end).not.toHaveProperty("thinkingUnclassified");
  });

  it("keeps none of the thinking words, and no signature, in the log", async () => {
    const text = JSON.stringify(await lines());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(NARRATION_SIGNATURE.slice(0, 40));
    expect(text).not.toContain("garbage-that-is-not-a-signature");
  });

  it("still logs the counts and stop reason as before", async () => {
    const end = await send("claude", { model: "m" });
    expect(end).toMatchObject({ outcome: "done", model: "claude-sonnet-5-5", stopReason: "end_turn", tokens: { input: 12, output: 40 } });
  });
});

describe("the reader of a Messages stream", () => {
  it("collects each thinking block's signature and whether it had words, one character at a time included", () => {
    const r = usageReader();
    for (const ch of STREAM) r.feed(ch);
    const got = r.result();
    expect(got?.thinking).toEqual([
      { hasText: true, signature: NARRATION_SIGNATURE },
      { hasText: true, signature: THINKING_SIGNATURE },
      { hasText: true, signature: "garbage-that-is-not-a-signature" },
    ]);
    expect(JSON.stringify(got)).not.toContain(SECRET);
  });

  it("marks a block with no words, and gives no blocks for a stream without thinking", () => {
    const r = usageReader();
    r.feed('data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n');
    r.feed('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n');
    r.feed('data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}\n');
    expect(r.result()?.thinking).toEqual([{ hasText: false, signature: "abc" }]);
    const none = usageReader();
    none.feed('data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n');
    expect(none.result()?.thinking).toBeUndefined();
  });
});
