import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A run names its chat in the x-llama-session header when it calls the server's
// own model proxy. The server believes it only from this computer, and only
// puts the id (never the header) into the audit lines.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { load, save } = await import("../store.ts");
const { handler, sessionFromHeader } = await import("../plugin.ts");
const { auditDir } = await import("../audit.ts");
const { runWithCause } = await import("../auditContext.ts");
const { streamChat } = await import("../../src/api.ts");

beforeAll(async () => {
  await save({ ...(await load()), connectors: [{ id: "c1", name: "t", url: "http://127.0.0.1:1", apiKey: "sk-test", kind: "llama", api: "anthropic" }] });
});
afterEach(() => vi.unstubAllGlobals());

const lines = async () => {
  const dir = auditDir();
  const files = (await readdir(dir).catch(() => [])).sort();
  const all = (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")))).join("");
  return all.split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

function post(address: string, headers: Record<string, string>) {
  const req = Object.assign(Readable.from([Buffer.from("{}")]), {
    method: "POST",
    url: "/c/c1/v1/messages",
    headers: { "content-type": "application/json", ...headers },
    socket: { remoteAddress: address },
  }) as unknown as IncomingMessage;
  const out = new PassThrough();
  out.on("data", () => {});
  const res = Object.assign(out, { statusCode: 200, setHeader() {} }) as unknown as ServerResponse;
  (handler as any)(req, res, () => {});
  return res;
}

async function requestLine(id: string) {
  return vi.waitFor(async () => {
    const found = (await lines()).filter((l) => l.event === "api.request" && l.who?.agent === id);
    expect(found).toHaveLength(1);
    return found[0];
  });
}

const saveChat = async (id: string) => {
  const { sessionFile } = await import("../sessionFile.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.dirname(sessionFile(id)), { recursive: true });
  writeFileSync(sessionFile(id), JSON.stringify({ id, title: "Open chat", messages: [] }));
};

describe("the chat named in x-llama-session", () => {
  it("is ignored from this computer when no such chat exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    post("127.0.0.1", { "x-llama-session": "ghost-chat", "user-agent": "ghost" });
    expect((await requestLine("ghost")).session).toBeUndefined();
  });

  it("is used from this computer, on the request line and on the proxy's own fetch line", async () => {
    await saveChat("chat-1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })));
    post("127.0.0.1", { "x-llama-session": "chat-1:a", "user-agent": "loop" });
    const line = await requestLine("loop");
    expect(line.session).toBe("chat-1:a");
    const fetched = (await lines()).filter((l) => l.event === "io.fetch" && l.why === "model.proxy" && l.request === line.request);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].session).toBe("chat-1:a");
    // Only the id is written, never the header.
    expect(JSON.stringify(await lines())).not.toContain("x-llama-session");
  });

  it("is ignored from any other address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    post("192.168.1.20", { "x-llama-session": "chat-evil", "user-agent": "lan" });
    const line = await requestLine("lan");
    expect(line.session).toBeUndefined();
    expect(JSON.stringify(await lines())).not.toContain("chat-evil");
  });

  it("is ignored when badly shaped, and when no chat has that id", async () => {
    await saveChat("ok-1");
    const req = (headers: Record<string, string>) =>
      ({ headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    expect(sessionFromHeader(req({ "x-llama-session": "ok-1" }))).toBe("ok-1");
    expect(sessionFromHeader(req({ "x-llama-session": "nobody" }))).toBeUndefined();
    expect(sessionFromHeader(req({ "x-llama-session": "../etc" }))).toBeUndefined();
    expect(sessionFromHeader(req({ "x-llama-session": "a".repeat(81) }))).toBeUndefined();
    expect(sessionFromHeader(req({}))).toBeUndefined();
  });
});

describe("the chat the page names for the chat it has open", () => {
  const stub = () => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })));

  it("is used from any address when that chat's file exists (a refused request is still labelled)", async () => {
    await saveChat("page-chat");
    stub();
    post("192.168.1.30", { "x-llama-session": "page-chat", "user-agent": "page-lan" });
    const line = await requestLine("page-lan");
    expect(line.status).toBe(401);
    expect(line.session).toBe("page-chat");
  });

  it("puts the chat on the request line and on the fetch it triggers", async () => {
    await saveChat("page-chat");
    stub();
    post("127.0.0.1", { "x-llama-session": "page-chat", "user-agent": "page" });
    const line = await requestLine("page");
    expect(line.session).toBe("page-chat");
    const fetched = (await lines()).filter((l) => l.event === "io.fetch" && l.request === line.request);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((l) => l.session === "page-chat")).toBe(true);
    expect(JSON.stringify(await lines())).not.toContain("x-llama-session");
  });

  it("is ignored from another address when there is no such chat or the id is badly shaped", async () => {
    stub();
    post("192.168.1.31", { "x-llama-session": "no-such-chat", "user-agent": "missing" });
    expect((await requestLine("missing")).session).toBeUndefined();
    post("192.168.1.32", { "x-llama-session": "bad/../shape", "user-agent": "shape" });
    expect((await requestLine("shape")).session).toBeUndefined();
  });

  it("changes nothing when there is no header", async () => {
    stub();
    post("192.168.1.33", { "user-agent": "plain" });
    expect((await requestLine("plain")).session).toBeUndefined();
  });

  it("is sent by the page for the open chat, and a run's own chat wins", async () => {
    const api = await import("../../src/api.ts");
    expect(api.sessionHeaders()).toEqual({});
    api.setOpenSession("open-1");
    expect(api.sessionHeaders()).toEqual({ "x-llama-session": "open-1" });
    await runWithCause({ session: "run-9" }, async () => {
      expect(api.sessionHeaders()).toEqual({ "x-llama-session": "run-9" });
    });
    api.setOpenSession(undefined);
    expect(api.sessionHeaders()).toEqual({});
  });
});

describe("a run's call to the model proxy", () => {
  it("sends the chat it is running for in the header, and none outside a run", async () => {
    const { setApiOrigin } = await import("../../src/api.ts");
    setApiOrigin("http://self.test");
    const seen: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: any) => {
        seen.push(new Headers(init?.headers).get("x-llama-session"));
        return new Response("{}", { status: 500 });
      }),
    );
    const ask = () =>
      streamChat({ connectorId: "c1", model: "m", messages: [{ role: "user", content: "hi" }], purpose: { kind: "background" }, kind: "llama", api: "anthropic" }, () => {}, new AbortController().signal).catch(() => {});
    await runWithCause({ session: "run-7" }, ask);
    await ask();
    expect(seen.filter((s) => s === "run-7").length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeNull();
    setApiOrigin(null);
  });
});
