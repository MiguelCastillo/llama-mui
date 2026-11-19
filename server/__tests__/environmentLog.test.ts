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


import { existsSync, readdirSync } from "node:fs";
const { environmentChanges } = await import("../sessionEnvironment.ts");

const logLines = async () => {
  const dir = path.join(home.dir, ".llama-mui", "logs");
  const out: any[] = [];
  for (const f of existsSync(dir) ? readdirSync(dir) : []) for (const l of (await readFile(path.join(dir, f), "utf8")).split("\n")) if (l) out.push(JSON.parse(l));
  return out.filter((l) => l.event === "session.environment");
};
const started = [{ role: "user", content: "SECRET PROMPT" }];
const env = { connectorId: "local", model: "m1", workingDir: "/work/a", attachments: [{ path: "/work/b" }], autoApprove: { commands: true } };

describe("the log of environment changes", () => {
  it("names only model, connection and folder names, never approvals or persona content", () => {
    const c = environmentChanges(env, { ...env, model: "m2", workingDir: "/secret/place/c", autoApprove: { commands: false }, persona: "p" });
    expect(c).toEqual([
      { item: "model", from: "m1", to: "m2" },
      { item: "workingDir", from: "a", to: "c" },
      { item: "autoApprove" },
      { item: "persona" },
    ]);
    expect(JSON.stringify(c)).not.toContain("/secret");
  });

  it("logs a user's choice, and a refused stale save, each with the chat id and who asked", async () => {
    await call("PUT", ["lg"], { id: "lg", messages: started, ...env });
    expect((await logLines()).filter((l) => l.chat === "lg")).toEqual([]); // creating one logs nothing
    await call("POST", ["lg", "environment"], { item: "model", value: "m2" });
    await call("PUT", ["lg"], { id: "lg", messages: started, ...env, model: "stale", workingDir: "/other/dir" });
    const lines = (await logLines()).filter((l) => l.chat === "lg");
    expect(lines.map(({ t: _t, pid: _p, event: _e, ...rest }) => rest)).toEqual([
      { chat: "lg", who: "user choice", item: "model", from: "m1", to: "m2" },
      { chat: "lg", who: "refused save", item: "model", from: "m2", to: "stale" },
      { chat: "lg", who: "refused save", item: "workingDir", from: "a", to: "dir" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("SECRET PROMPT");
  });

  it("logs nothing for a save that changes nothing", async () => {
    await call("PUT", ["lg2"], { id: "lg2", messages: started, ...env });
    await call("PUT", ["lg2"], { id: "lg2", messages: started, ...env });
    expect((await logLines()).filter((l) => l.chat === "lg2")).toEqual([]);
  });
});
