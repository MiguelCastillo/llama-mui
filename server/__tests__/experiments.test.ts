import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

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

const { load } = await import("../store.ts");
const { experimentRoutes } = await import("../experiments.ts");

const invoke = async (method: string, body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    headers: {},
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await experimentRoutes({ req, res, parts: ["experiments"], method, search: "" } as any);
  return { status: res.statusCode, body: text ? JSON.parse(text) : {} };
};

const writeSettings = (settings: unknown) => {
  const dir = path.join(home.dir, ".llama-mui");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
};

describe("the experiments setting", () => {
  it("is off when there are no settings yet", async () => {
    expect((await load()).experiments).toEqual({ progressNotes: false });
    expect((await invoke("GET")).body).toEqual({ progressNotes: false });
  });

  it("is off for a settings file saved before it existed, and the rest of the file is kept", async () => {
    writeSettings({ preferences: { renderMarkdown: false }, dailyTokenLimit: 5 });
    const store = await load();
    expect(store.experiments).toEqual({ progressNotes: false });
    expect(store.preferences.renderMarkdown).toBe(false);
    expect(store.dailyTokenLimit).toBe(5);
  });

  it("is saved after a change, and a change leaves the other settings alone", async () => {
    writeSettings({ dailyTokenLimit: 5 });
    expect((await invoke("PATCH", { progressNotes: true })).body).toEqual({ progressNotes: true });
    expect((await invoke("GET")).body.progressNotes).toBe(true);
    const store = await load();
    expect(store.experiments.progressNotes).toBe(true);
    expect(store.dailyTokenLimit).toBe(5);
    expect((await invoke("PATCH", { progressNotes: false })).body.progressNotes).toBe(false);
  });

  it("ignores a key it doesn't know, in the file and in a change", async () => {
    writeSettings({ experiments: { progressNotes: true, somethingNewer: true } });
    const loaded = (await load()).experiments;
    expect(loaded).toEqual({ progressNotes: true });
    const patched = await invoke("PATCH", { somethingNewer: true });
    expect(patched.body).toEqual({ progressNotes: true });
    expect(patched.body).not.toHaveProperty("somethingNewer");
    // A saved value that isn't true or false falls back to off.
    writeSettings({ experiments: { progressNotes: "yes" } });
    expect((await load()).experiments).toEqual({ progressNotes: false });
  });

  it("refuses a value that isn't true or false", async () => {
    await expect(invoke("PATCH", { progressNotes: "yes" })).rejects.toThrow(/Invalid experiment: progressNotes must be true or false/);
    await expect(invoke("PATCH", { progressNotes: 1 })).rejects.toThrow(/Invalid experiment/);
  });

  it("answers only its own address", async () => {
    const req = Object.assign(Readable.from([]), { method: "GET", headers: {} }) as unknown as IncomingMessage;
    const res = { statusCode: 200, setHeader() {}, on() {}, end() {} } as unknown as ServerResponse;
    expect(await experimentRoutes({ req, res, parts: ["preferences"], method: "GET", search: "" } as any)).toBe(false);
  });
});
