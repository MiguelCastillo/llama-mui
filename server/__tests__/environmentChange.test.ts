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
const { writeSession } = await import("../sessionFile.ts");
const { ENVIRONMENT_ITEMS } = await import("../sessionEnvironment.ts");
const { sessionActions } = await import("../allowedActions.ts");

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
  attachments: [{ path: "/work/b", kind: "folder", source: "user" }],
  autoApprove: { commands: true },
};
const chosen: Record<string, unknown> = {
  connectorId: "other",
  model: "new-model",
  workingDir: "/work/new",
  attachments: [],
  autoApprove: { commands: false, changes: true },
};
const started = [{ role: "user", content: "hi" }];
const change = (id: string, item: string, value: unknown) => call("POST", [id, "environment"], { item, value });

describe("changing one environment item at the user's request", () => {
  it("changes each item when nothing runs the chat, and the change shows in the session", async () => {
    await call("PUT", ["chg"], { id: "chg", messages: started, ...environment });
    let revision = (await call("GET", ["chg"])).body.revision;
    for (const item of ENVIRONMENT_ITEMS) {
      if (!item.choose) continue;
      const r = await change("chg", item.key, chosen[item.key]);
      expect(r.status, item.key).toBe(200);
      expect(r.body.revision, item.key).toBe(revision + 1);
      expect(r.body.environment[item.key]).toEqual(chosen[item.key]);
      revision = r.body.revision;
    }
    const saved = await onDisk("chg");
    for (const item of ENVIRONMENT_ITEMS) if (item.choose) expect(saved[item.key], item.key).toEqual(chosen[item.key]);
    const got = (await call("GET", ["chg"])).body;
    expect(got.model).toBe("new-model");
    expect(got.revision).toBe(revision);
    expect(got.messages).toEqual(started); // nothing else moved
  });

  it("accepts no folder (null) and refuses invalid values and unknown or fixed items", async () => {
    await call("PUT", ["chg2"], { id: "chg2", messages: started, ...environment, persona: "p" });
    expect((await change("chg2", "workingDir", null)).status).toBe(200);
    expect((await onDisk("chg2")).workingDir).toBeNull();
    expect((await change("chg2", "model", "")).status).toBe(400);
    expect((await change("chg2", "model", 5)).status).toBe(400);
    expect((await change("chg2", "autoApprove", { commands: "yes" })).status).toBe(400);
    expect((await change("chg2", "attachments", ["/x"])).status).toBe(400);
    expect((await change("chg2", "persona", "other")).status).toBe(400);
    expect((await change("chg2", "title", "x")).status).toBe(400);
    const saved = await onDisk("chg2");
    expect(saved).toMatchObject({ model: "chosen-model", persona: "p" });
  });

  it("answers 404 for a chat that is not saved", async () => {
    expect((await change("nope", "model", "m")).status).toBe(404);
  });

  it("is refused while a run holds the chat, and nothing changes", async () => {
    await call("PUT", ["chg-run"], { id: "chg-run", messages: started, ...environment });
    await hub.beginRun("chg-run");
    for (const item of ["model", "connectorId", "workingDir", "attachments", "autoApprove"]) {
      const r = await change("chg-run", item, chosen[item]);
      expect(r.status, item).toBe(409);
      expect(r.body.error).toMatch(/running in this chat.*was not changed/);
    }
    expect(await onDisk("chg-run")).toMatchObject(environment);
    await hub.endRun("chg-run");
    expect((await change("chg-run", "model", "new-model")).status).toBe(200);
  });

  it("is refused when another server owns the run", async () => {
    const now = Date.now();
    const run = { startedAt: now, owner: { pid: 1, port: 1, checkedAt: now, serverId: "another-server" } };
    await writeSession("chg-else", { id: "chg-else", title: "t", createdAt: now, updatedAt: now, revision: 1, messages: started, ...environment, run });
    const r = await change("chg-else", "model", "new-model");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Another server/);
    expect((await onDisk("chg-else")).model).toBe("chosen-model");
  });
});

describe("the allowed-actions list and changing the environment", () => {
  const now = 1_000_000;
  const owner = (over: object = {}) => ({ pid: 1, port: 5173, checkedAt: now - 1000, serverId: "me", ...over });
  const record = (over: object = {}) => ({ startedAt: now - 5000, owner: owner(), ...over });
  const actions = (run: any) => sessionActions({}, run, now, "me");

  it("lists it when nobody runs the chat", () => {
    expect(actions(null)).toContain("changeEnvironment");
  });
  it("leaves it out when this server runs it", () => {
    expect(actions(record())).not.toContain("changeEnvironment");
    expect(actions(record({ kind: "turn" }))).not.toContain("changeEnvironment");
  });
  it("leaves it out when another server owns the run or the owner is unknown", () => {
    expect(actions(record({ owner: owner({ serverId: "other" }) }))).not.toContain("changeEnvironment");
    expect(actions({ startedAt: 1 })).not.toContain("changeEnvironment");
    expect(actions("garbage")).not.toContain("changeEnvironment");
    expect(sessionActions(null, null)).toEqual([]);
  });
});
