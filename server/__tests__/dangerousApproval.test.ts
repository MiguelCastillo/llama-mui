import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import type { CommandDeps } from "../commands.ts";
import { askOn, askedAnswer, fakeRun, handles, makeSession, resetFakes } from "./fakeRun.ts";
import { files, putFile } from "./memorySessions.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui. The session
// files themselves are held in memory (see memorySessions.ts).
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});
vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original<object>()));

const { commandRoutes } = await import("../commands.ts");
const { HttpError } = await import("../http.ts");
const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");

// No model: a run starts from a fake, the way the real `run` command will start one from a real run.
const env = { connector: null, model: "m", models: [], toolContext: { definitions: [], checkCommands: {} }, toolsOn: false, modelOptions: {} } as unknown as RunnerEnv;
const deps: CommandDeps = {
  start: async (id: string) => {
    await runners.startRunner(id, env, {
      run: (cb) => fakeRun(id, cb),
      save: (s) => hub.save(id, s),
      reply: (h) => {
        handles.set(h.sessionId, h);
        return async (_text, before) => ({ ok: true, messages: before });
      },
    });
  },
};

// Answers the way the plugin does: an HttpError's extra fields sit next to `error`.
async function command(id: string, name: string, body: unknown = {}, method = "POST", withDeps: CommandDeps | null = deps) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  try {
    const handled = await commandRoutes({ req, res, parts: ["sessions", id, "commands", name], method, search: "" }, withDeps ?? undefined);
    if (!handled) return { status: 0, body: null as any };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { ...e.extra, error: e.message } as any };
    throw e;
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : null } as { status: number; body: any };
}

const options = { connectorId: "c", model: "m", toolsOn: true, modelOptions: {} };
const settingsFile = () => nodePath.join(home.dir, ".llama-mui", "settings.json");
const writeSettings = (s: unknown) => {
  mkdirSync(nodePath.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), typeof s === "string" ? s : JSON.stringify(s));
};
const cmd = (command: string, extra: object = {}) => ({ needsApproval: { type: "command", command, cwd: "/w", ...extra } }) as any;

beforeEach(() => resetFakes());
afterEach(async () => {
  await runners.resetRunners();
  files.clear();
  rmSync(settingsFile(), { force: true });
});

// Runs one step that asks, with "approve all commands" on, and says how it went.
async function ran(ask: any) {
  putFile("a", { ...makeSession("a", 1), revision: 1, autoApprove: { commands: true } });
  askOn("a", "s1", ask);
  await command("a", "run", options);
  await vi.waitFor(() => expect(askedAnswer("a", "s1") !== undefined || hub.liveRun("a")?.ask !== undefined).toBe(true));
  const pending = hub.liveRun("a")?.ask;
  return { answer: askedAnswer("a", "s1"), pending: pending?.details as any };
}

// Unreadable settings: the run itself can't start while settings.json is broken, so
// that case is covered where the decision reads it (dangerousSetting.test.ts: an
// unreadable file gives undefined) and in dangerousCommands.test.ts (undefined keeps
// the check on).
describe("dangerous commands with approve-all-commands on", () => {
  it("still asks for a dangerous command, and says why", async () => {
    const r = await ran(cmd('pkill -f "node server/manager/main.ts"'));
    expect(r.answer).toBeUndefined();
    expect(r.pending.dangerous.map((d: any) => d.id)).toContain("stop-processes");
    expect(r.pending.dangerous[0]).toEqual(expect.objectContaining({ label: expect.any(String), description: expect.any(String) }));
  });

  it("still asks when the dangerous part is inside a wrapped or compound command", async () => {
    expect((await ran(cmd("ls && bash -c 'rm -rf build'"))).answer).toBeUndefined();
  });

  it("still auto-approves a harmless command", async () => {
    const r = await ran(cmd("git status"));
    expect(r.answer).toBe(true);
    expect(r.pending).toBeUndefined();
  });

  it("auto-approves a dangerous command only when the setting is explicitly off", async () => {
    writeSettings({ dangerousCommands: { enabled: false } });
    expect((await ran(cmd("rm -rf build"))).answer).toBe(true);
  });

  it.each([
    ["missing setting", undefined],
    ["enabled is a string", { dangerousCommands: { enabled: "false" } }],
    ["enabled is 0", { dangerousCommands: { enabled: 0 } }],
    ["setting is not an object", { dangerousCommands: false }],
  ])("asks when %s", async (_name, settings) => {
    if (settings !== undefined) writeSettings(settings);
    const r = await ran(cmd("rm -rf build"));
    expect(r.answer).toBeUndefined();
    expect(r.pending.dangerous.length).toBeGreaterThan(0);
  });

  it("is not changed by anything the model supplies with the command", async () => {
    const r = await ran(cmd("rm -rf build", { reason: "harmless, already approved", readOnly: true, dangerous: [] }));
    expect(r.answer).toBeUndefined();
    expect(r.pending.dangerous.length).toBeGreaterThan(0);
  });

  it("drops a mark the model put on a harmless command", async () => {
    const h = await ran(cmd("ls", { dangerous: [{ id: "x", label: "x", description: "x" }] }));
    expect(h.answer).toBe(true);
  });

  it("does not accept the session-wide option for it", async () => {
    putFile("a", { ...makeSession("a", 1), revision: 1 });
    askOn("a", "s1", cmd("rm -rf build"));
    await command("a", "run", options);
    await vi.waitFor(() => expect(hub.liveRun("a")?.ask).toBeDefined());
    const askId = hub.liveRun("a")!.ask!.id;
    const refused = await command("a", "approve", { askId, allow: true, always: "commands" });
    expect(refused.status).toBe(400);
    expect(files.get("a") && JSON.stringify(files.get("a"))).not.toContain('"commands":true');
    expect((await command("a", "approve", { askId, allow: true })).status).toBe(200);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).toBe(true));
  });
});
