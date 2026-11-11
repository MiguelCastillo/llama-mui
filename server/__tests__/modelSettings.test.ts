import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const { modelAnswer } = await import("../../src/__tests__/capabilityFixtures.ts");
const { forgetCapabilities } = await import("../../src/api.ts");
const { modelSettingRoutes } = await import("../models.ts");

const invoke = async (method: string, body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    headers: {},
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await modelSettingRoutes({ req, res, parts: ["model-settings"], method, search: "" } as any);
  return { status: res.statusCode, body: text ? JSON.parse(text) : {} };
};

const CLAUDE = "claude-opus-5-5";

describe("a model's effort", () => {
  it("is left out by default", async () => {
    expect((await invoke("GET")).body.defaults).toEqual({ think: false });
  });

  it("can be set, keeping Think, and is saved", async () => {
    await invoke("PATCH", { model: CLAUDE, think: true });
    expect((await invoke("PATCH", { model: CLAUDE, effort: "xhigh" })).body).toEqual({ think: true, effort: "xhigh" });
    expect((await load()).models[CLAUDE]).toEqual({ think: true, effort: "xhigh" });
    // Changing Think leaves it alone.
    expect((await invoke("PATCH", { model: CLAUDE, think: false })).body).toEqual({ think: false, effort: "xhigh" });
  });

  it("is cleared by null or an empty string", async () => {
    await invoke("PATCH", { model: CLAUDE, effort: "low" });
    expect((await invoke("PATCH", { model: CLAUDE, effort: null })).body).not.toHaveProperty("effort");
    await invoke("PATCH", { model: CLAUDE, effort: "max" });
    expect((await invoke("PATCH", { model: CLAUDE, effort: "" })).body).not.toHaveProperty("effort");
    expect((await load()).models[CLAUDE]).not.toHaveProperty("effort");
  });

  it("must be one of the levels", async () => {
    await expect(invoke("PATCH", { model: CLAUDE, effort: "extreme" })).rejects.toThrow(/effort must be one of low, medium, high, xhigh, max/);
    await expect(invoke("PATCH", { model: CLAUDE, effort: 3 })).rejects.toThrow(/effort must be one of/);
  });
});

// With a connector, the connection's module checks the settings: Think for
// llama.cpp, and for Claude the effort levels the model's own capabilities
// (the Models API's real answers) say it supports.
describe("a model's settings, checked by its connection", () => {
  const connector = (id: string, kind: "llama" | "anthropic") => ({ id, kind, name: id, url: "http://x", api: "anthropic" as const, apiKey: "" });
  const SONNET = "claude-sonnet-5-5";
  const HAIKU = "claude-haiku-4-5-20251001";

  const withConnectors = async () => {
    const store = await load();
    store.connectors = [connector("llama-c", "llama"), connector("claude-c", "anthropic")] as any;
    await save(store);
    forgetCapabilities();
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => modelAnswer(String(url), init?.method) ?? new Response("{}", { status: 404 })));
  };
  afterEach(() => vi.unstubAllGlobals());

  it("takes a level the Claude model supports", async () => {
    await withConnectors();
    expect((await invoke("PATCH", { model: SONNET, connectorId: "claude-c", effort: "max" })).body).toMatchObject({ effort: "max" });
  });

  it("refuses an effort for a Claude model that takes none (Haiku 4.5)", async () => {
    await withConnectors();
    await expect(invoke("PATCH", { model: HAIKU, connectorId: "claude-c", effort: "low" })).rejects.toThrow(/no effort setting/);
    expect((await load()).models[HAIKU]).toBeUndefined();
  });

  it("still clears an effort on a model that takes none", async () => {
    await withConnectors();
    expect((await invoke("PATCH", { model: HAIKU, connectorId: "claude-c", effort: null })).body).not.toHaveProperty("effort");
  });

  it("leaves a Claude model's Think alone, and doesn't save an effort for llama.cpp", async () => {
    await withConnectors();
    const claude = (await invoke("PATCH", { model: "claude-opus-5-5", connectorId: "claude-c", think: true })).body;
    expect(claude).toEqual({ think: false });
    const llama = (await invoke("PATCH", { model: "qwen", connectorId: "llama-c", think: true, effort: "high" })).body;
    expect(llama).toEqual({ think: true });
  });

  it("still refuses a Think that isn't a boolean", async () => {
    await withConnectors();
    await expect(invoke("PATCH", { model: "qwen", connectorId: "llama-c", think: "yes" })).rejects.toThrow(/think must be true or false/);
  });
});
