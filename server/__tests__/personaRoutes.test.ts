import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Home folder pointed at a temp one, so the real personas and settings are untouched.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { load, save } = await import("../store.ts");
const { personaRoutes, resolveDefaultPersona } = await import("../personaRoutes.ts");
const { appPersonasDir } = await import("../personas.ts");

// Personas come from a folder of the test's own, starting with the app's Builder.md.
const testPersonas = path.join(home.dir, ".llama-mui", "personas");
process.env.LLAMA_MUI_PERSONAS_DIR = testPersonas;
mkdirSync(testPersonas, { recursive: true });
copyFileSync(path.join(appPersonasDir(), "Builder.md"), path.join(testPersonas, "Builder.md"));

const invoke = async (method: string, parts: string[], body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    headers: {},
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  const handled = await personaRoutes({ req, res, parts, method, search: "" } as any);
  return { handled, status: res.statusCode, body: text ? JSON.parse(text) : {} };
};

const personasDir = () => path.join(home.dir, ".llama-mui", "personas");
const writePersona = (file: string, text: string) => {
  mkdirSync(personasDir(), { recursive: true });
  writeFileSync(path.join(personasDir(), file), text);
};

describe("the personas list", () => {
  it("has Builder and defaults to it when nothing is saved", async () => {
    const r = await invoke("GET", ["personas"]);
    expect(r.body.defaultPersona).toBe("Builder");
    expect(r.body.personas.map((p: any) => p.name)).toContain("Builder");
    expect(r.body.personas[0]).toEqual({ name: "Builder", description: expect.any(String) });
    expect(r.body.personas[0]).not.toHaveProperty("instructions");
    expect(r.body.folder).toBe(testPersonas);
  });

  it("includes a persona file and reports a broken one", async () => {
    writePersona("Reviewer.md", "---\nname: Reviewer\ndescription: Reads code\n---\nLook, don't touch.");
    writePersona("broken.md", "no header here");
    const r = await invoke("GET", ["personas"]);
    expect(r.body.personas).toContainEqual({ name: "Reviewer", description: "Reads code" });
    const messages = r.body.problems.map((p: any) => p.message).join("\n");
    expect(messages).toMatch(/broken\.md/);
  });
});

describe("the default persona", () => {
  it("is stored in the settings and returned", async () => {
    expect((await invoke("PUT", ["personas", "default"], { name: "Reviewer" })).body.defaultPersona).toBe("Reviewer");
    expect((await load()).defaultPersona).toBe("Reviewer");
    expect((await invoke("GET", ["personas"])).body.defaultPersona).toBe("Reviewer");
  });

  it("can't be set to a persona that doesn't exist", async () => {
    await expect(invoke("PUT", ["personas", "default"], { name: "Nobody" })).rejects.toThrow(/no persona named/);
  });

  it("falls back to Builder with a problem message when the saved one is gone", async () => {
    const store = await load();
    store.defaultPersona = "Deleted";
    await save(store);
    const r = await invoke("GET", ["personas"]);
    expect(r.body.defaultPersona).toBe("Builder");
    expect(r.body.problems.map((p: any) => p.message).join("\n")).toMatch(/"Deleted" doesn't exist/);
  });

  it("is Builder for a settings file saved before it existed", async () => {
    writeFileSync(path.join(home.dir, ".llama-mui", "settings.json"), JSON.stringify({ toolsEnabled: true }));
    expect((await load()).defaultPersona).toBe("Builder");
  });

  it("ignores case when matching, and returns the persona's own spelling", async () => {
    expect(await resolveDefaultPersona("builder", ["Builder"])).toEqual({ name: "Builder", problem: null });
  });
});

describe("other paths", () => {
  it("are left to other routes", async () => {
    expect((await invoke("GET", ["rules"])).handled).toBe(false);
  });
});
