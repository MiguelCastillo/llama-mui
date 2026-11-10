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
const { preferenceRoutes } = await import("../preferences.ts");

const invoke = async (method: string, body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    headers: {},
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await preferenceRoutes({ req, res, parts: ["preferences"], method, search: "" } as any);
  return { status: res.statusCode, body: text ? JSON.parse(text) : {} };
};

describe("the model name preference", () => {
  it("is off when there are no settings yet", async () => {
    expect((await load()).preferences.showModelName).toBe(false);
  });

  it("is off for a settings file saved before it existed, and the other preferences are kept", async () => {
    const dir = path.join(home.dir, ".llama-mui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ preferences: { renderMarkdown: false } }));
    const prefs = (await load()).preferences;
    expect(prefs.showModelName).toBe(false);
    expect(prefs.renderMarkdown).toBe(false);
  });

  it("loads a settings file that still holds the removed Show steps preference, and doesn't return it", async () => {
    const dir = path.join(home.dir, ".llama-mui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ preferences: { showSteps: false, renderMarkdown: false } }));
    const prefs = (await load()).preferences;
    expect(prefs).not.toHaveProperty("showSteps");
    expect(prefs.renderMarkdown).toBe(false);
    expect(await invoke("GET")).toMatchObject({ status: 200 });
    expect((await invoke("GET")).body).not.toHaveProperty("showSteps");
  });

  it("can be turned on and off through the preferences route", async () => {
    expect((await invoke("PATCH", { showModelName: true })).body.showModelName).toBe(true);
    expect((await invoke("GET")).body.showModelName).toBe(true);
    expect((await load()).preferences.showModelName).toBe(true);
    expect((await invoke("PATCH", { showModelName: false })).body.showModelName).toBe(false);
  });

  it("must be a boolean", async () => {
    await expect(invoke("PATCH", { showModelName: "yes" })).rejects.toThrow(/Invalid preference/);
  });
});
