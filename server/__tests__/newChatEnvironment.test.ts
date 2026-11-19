import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Home folder pointed at a temp one: these tests never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { HttpError } = await import("../http.ts");
const { sessionRoutes } = await import("../sessions.ts");
const { load, save } = await import("../store.ts");
const { newChatEnvironment } = await import("../sessionEnvironment.ts");

const onDisk = async (id: string) =>
  JSON.parse(await readFile(path.join(home.dir, ".llama-mui", "sessions", id, "session.json"), "utf8"));

const call = async (method: string, parts: string[], body?: unknown) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  try {
    await sessionRoutes({ req, res, parts: ["sessions", ...parts], method, search: "" });
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { ...e.extra, error: e.message } as any };
    throw e;
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : null } as { status: number; body: any };
};

const conn = (id: string, defaultModel?: string) => ({ id, name: id, url: "http://127.0.0.1:1", apiKey: "", kind: "llama" as const, ...(defaultModel ? { defaultModel } : {}) });

describe("what a new chat starts with (pure)", () => {
  const connectors = [conn("a", "model-a"), conn("b")];
  it("takes the newest chat's connection if it still exists, and that connection's default model", () => {
    const env = newChatEnvironment({ connectors, recent: [{ connectorId: "gone" }, { connectorId: "a" }, { connectorId: "b" }], persona: "Builder" });
    expect(env).toEqual({ connectorId: "a", model: "model-a", persona: "Builder" });
  });
  it("takes the first connection when no chat has one, and has no model if it has no default", () => {
    expect(newChatEnvironment({ connectors, recent: [] })).toEqual({ connectorId: "a", model: "model-a" });
    expect(newChatEnvironment({ connectors, recent: [{ connectorId: "b" }] })).toEqual({ connectorId: "b" });
  });
  it("has nothing to pick with no connections", () => {
    expect(newChatEnvironment({ connectors: [], recent: [], persona: "Builder" })).toEqual({ persona: "Builder" });
  });
});

describe("creating a chat", () => {
  it("arrives with its environment filled by the server, and the folder as sent", async () => {
    await save({ ...(await load()), connectors: [conn("c1", "m-default"), conn("c2")], defaultPersona: "Builder" });
    const r = await call("POST", [], { id: "new1", workingDir: "/work/here" });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    expect(r.body.environment).toMatchObject({ connectorId: "c1", model: "m-default", persona: "Builder", workingDir: "/work/here" });
    expect(await onDisk("new1")).toMatchObject({ id: "new1", messages: [], connectorId: "c1", model: "m-default", persona: "Builder", workingDir: "/work/here" });
    expect((await call("GET", ["new1"])).body.model).toBe("m-default");
  });

  it("uses the last used connection, from the newest chat", async () => {
    await call("PUT", ["used"], { id: "used", messages: [{ role: "user", content: "hi" }], connectorId: "c2", model: "x" });
    const r = await call("POST", [], { id: "new2" });
    expect(r.body.environment.connectorId).toBe("c2");
    expect(r.body.environment.model).toBeUndefined(); // c2 has no default model: the server picks none
  });

  it("never re-runs for a chat that exists: it is answered as it is and nothing is written", async () => {
    await call("PUT", ["old"], { id: "old", messages: [{ role: "user", content: "hi" }], connectorId: "c2", model: "kept", workingDir: "/w", persona: "Reviewer" });
    const before = await onDisk("old");
    const r = await call("POST", [], { id: "old", workingDir: "/other" });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(false);
    expect(r.body.environment).toMatchObject({ connectorId: "c2", model: "kept", workingDir: "/w", persona: "Reviewer" });
    expect(await onDisk("old")).toEqual(before);
    // The same for an empty chat that was created before: the second call changes nothing, even if defaults moved on.
    await save({ ...(await load()), connectors: [conn("c9", "other-default")] });
    const again = await call("POST", [], { id: "new1" });
    expect(again.body.created).toBe(false);
    expect(again.body.environment).toMatchObject({ connectorId: "c1", model: "m-default" });
  });

  it("refuses a bad id", async () => {
    expect((await call("POST", [], { id: "../x" })).status).toBe(400);
    expect((await call("POST", [], {})).status).toBe(400);
  });
});

describe("a chat that is not saved yet", () => {
  it("is answered 'no such chat' together with what a new chat would start with, and nothing is written", async () => {
    await save({ ...(await load()), connectors: [conn("p1", "p-default")], defaultPersona: "Builder" });
    const r = await call("GET", ["never-saved"]);
    expect(r.status).toBe(404);
    expect(r.body.environment).toMatchObject({ connectorId: "p1", model: "p-default" });
    expect(await onDisk("never-saved").catch(() => null)).toBeNull();
  });
});
