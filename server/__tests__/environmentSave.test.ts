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
const hub = await import("../runHub.ts");
const { ENVIRONMENT_ITEMS, environmentForSave } = await import("../sessionEnvironment.ts");

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

const environment = {
  connectorId: "local",
  model: "chosen-model",
  workingDir: "/work/a",
  attachments: ["/work/b"],
  autoApprove: { write: true, commands: false },
};
const stale = {
  connectorId: "other",
  model: "default-model",
  workingDir: "/work/other",
  attachments: [],
  autoApprove: {},
};
const started = [{ role: "user", content: "hi" }];

describe("a save and the session environment", () => {
  it("lets a chat that has not started take what the page sent", async () => {
    await call("PUT", ["env-new"], { id: "env-new", messages: [], ...environment });
    expect(await onDisk("env-new")).toMatchObject(environment);
    await call("PUT", ["env-new"], { id: "env-new", messages: [], ...stale });
    // Approvals are the exception: once the chat exists only their own command changes them.
    const { autoApprove: _a, ...rest } = stale;
    expect(await onDisk("env-new")).toMatchObject({ ...rest, autoApprove: environment.autoApprove });
  });

  it("keeps every stored item of a started chat when a save sends stale or default values", async () => {
    await call("PUT", ["env-old"], { id: "env-old", messages: [], ...environment });
    await call("PUT", ["env-old"], { id: "env-old", messages: started, ...environment });
    const r = await call("PUT", ["env-old"], { id: "env-old", messages: started, ...stale });
    expect(r.status).toBe(200);
    const saved = await onDisk("env-old");
    for (const item of ENVIRONMENT_ITEMS) {
      if (item.key === "persona") continue;
      expect(saved[item.key], item.key).toEqual((environment as any)[item.key]);
    }
  });

  it("keeps the stored model and connection of a chat not started when a save leaves them out", async () => {
    await call("PUT", ["env-draft"], { id: "env-draft", messages: [], ...environment });
    const { model: _m, connectorId: _c, ...without } = environment;
    await call("PUT", ["env-draft"], { id: "env-draft", messages: [], ...without });
    expect(await onDisk("env-draft")).toMatchObject(environment);
  });

  it("keeps the stored connection when a save sends none, and invents nothing", async () => {
    await call("PUT", ["env-none"], { id: "env-none", messages: started, ...environment });
    await call("PUT", ["env-none"], { id: "env-none", messages: started });
    expect(await onDisk("env-none")).toMatchObject(environment);
    await call("PUT", ["env-none2"], { id: "env-none2", messages: started });
    const saved = await onDisk("env-none2");
    expect(saved).not.toHaveProperty("model");
    expect(saved).not.toHaveProperty("connectorId");
  });

  it("holds while a run is live and after it ends and is settled", async () => {
    await call("PUT", ["env-run"], { id: "env-run", messages: started, ...environment });
    await hub.beginRun("env-run");
    const during = await call("PUT", ["env-run"], { id: "env-run", messages: started, ...stale });
    expect(during.status).toBe(409);
    expect(await onDisk("env-run")).toMatchObject(environment);
    await hub.endRun("env-run");
    const after = await call("PUT", ["env-run"], { id: "env-run", messages: started, ...stale });
    expect(after.status).toBe(200);
    expect(await onDisk("env-run")).toMatchObject(environment);
  });

  it("treats a chat with a prompt folder as started, even with no messages", () => {
    const kept = environmentForSave({ messages: [], promptDir: null, ...environment }, stale);
    expect(kept).toMatchObject(environment);
  });
});
