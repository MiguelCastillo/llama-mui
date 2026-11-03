import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests write their own settings.json, never the real one.
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

const invoke = async (parts: string[], method: string, body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    headers: {},
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await connectorRoutes({ req, res, parts, method, search: "" } as any);
  return { status: res.statusCode, body: text ? JSON.parse(text) : {} };
};

const edit = { name: "t", url: "http://127.0.0.1:1" };
const listed = async () => (await invoke(["connectors"], "GET")).body.connectors[0];

beforeAll(async () => {
  await save({
    ...(await load()),
    connectors: [{ id: "c1", name: "t", url: "http://127.0.0.1:1", apiKey: "sk-x", kind: "llama" }],
    activeId: "c1",
  });
});

describe("a connector's default model", () => {
  it("starts unset", async () => {
    expect((await listed()).defaultModel).toBeUndefined();
  });

  it("is stored and returned by the update route, and saved in the settings", async () => {
    const out = await invoke(["connectors", "c1"], "PUT", { ...edit, defaultModel: "org/m:Q4" });
    expect(out.body.defaultModel).toBe("org/m:Q4");
    expect((await listed()).defaultModel).toBe("org/m:Q4");
    expect((await load()).connectors[0].defaultModel).toBe("org/m:Q4");
  });

  it("is kept by an update that doesn't mention it, like editing the connector in the dialog", async () => {
    await invoke(["connectors", "c1"], "PUT", { ...edit, name: "renamed" });
    const c = await listed();
    expect(c.name).toBe("renamed");
    expect(c.defaultModel).toBe("org/m:Q4");
  });

  it("is cleared by an empty string", async () => {
    await invoke(["connectors", "c1"], "PUT", { ...edit, name: "renamed", defaultModel: "" });
    expect((await listed()).defaultModel).toBeUndefined();
    expect("defaultModel" in (await load()).connectors[0]).toBe(false);
  });

  it("must be a string", async () => {
    await expect(invoke(["connectors", "c1"], "PUT", { ...edit, defaultModel: 3 })).rejects.toThrow(/string/);
  });
});
