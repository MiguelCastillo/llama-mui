import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// llama.cpp's GET /props goes through the connector proxy (the page asks it
// which modalities a model takes and whether its template thinks). Only GET,
// and the connector's key is added as for any proxied call.
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

const KEY = "sk-test-props-0123456789";

async function invoke(parts: string[], method: string, search = "") {
  const req = Object.assign(Readable.from([]), { method, headers: {} }) as unknown as IncomingMessage;
  const out = new PassThrough();
  let text = "";
  out.on("data", (d) => (text += d));
  const res = Object.assign(out, { statusCode: 200, setHeader() {} }) as unknown as ServerResponse;
  const handled = await connectorRoutes({ req, res, parts, method, search } as any);
  return { handled, status: res.statusCode, text };
}

beforeAll(async () => {
  await save({ ...(await load()), connectors: [{ id: "c1", name: "t", url: "http://127.0.0.1:1", apiKey: KEY, kind: "llama", api: "openai" }] });
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/c/<id>/props", () => {
  it("is forwarded to the server's /props with the model and the key, and answers what it says", async () => {
    const asked: { url: string; headers: any; method?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        asked.push({ url, headers: init.headers, method: init.method });
        return new Response(JSON.stringify({ modalities: { vision: true } }), { headers: { "content-type": "application/json" } });
      }),
    );
    const out = await invoke(["c", "c1", "props"], "GET", "?model=a%2Fb&autoload=false");
    expect(out.handled).toBe(true);
    expect(JSON.parse(out.text)).toEqual({ modalities: { vision: true } });
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe("http://127.0.0.1:1/props?model=a%2Fb&autoload=false");
    expect(asked[0].method).toBe("GET");
    expect(asked[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(out.text).not.toContain(KEY);
  });

  it("is not open to POST (changing the server's properties) or to other paths", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await invoke(["c", "c1", "props"], "POST")).handled).toBe(false);
    expect((await invoke(["c", "c1", "props", "x"], "GET")).handled).toBe(false);
    expect((await invoke(["c", "c1", "slots"], "GET")).handled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
