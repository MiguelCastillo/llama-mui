import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import type { CommandDeps } from "../commands.ts";
import { askOn, askedAnswer, fakeRun, handles, makeSession, resetFakes } from "./fakeRun.ts";
import { fileOf, files, putFile } from "./memorySessions.ts";

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
const saved = (id: string, extra: object = {}) => putFile(id, { ...makeSession(id, 1), revision: 1, ...extra });
const change = { needsApproval: { type: "change", path: "/w/a.ts", action: "edit", diff: "" } } as any;
const shell = { needsApproval: { type: "command", command: "rm -rf build", cwd: "/w" } } as any;

beforeEach(() => resetFakes());
afterEach(async () => {
  await runners.resetRunners();
  files.clear();
});

const waitingFor = async () => {
  await vi.waitFor(() => expect(hub.liveRun("a")?.ask).toBeDefined());
  return hub.liveRun("a")!.ask!.id;
};

describe("approve with always", () => {
  it("approves, and turns that kind on for the rest of the session", async () => {
    saved("a");
    askOn("a", "s1", change);
    await command("a", "run", options);
    const askId = await waitingFor();
    expect((await command("a", "approve", { askId, allow: true, always: "changes" })).status).toBe(200);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).toBe(true));
    expect(fileOf("a").autoApprove).toEqual({ changes: true });
  });

  it("does nothing extra for a no, and refuses a kind it doesn't know", async () => {
    saved("a");
    askOn("a", "s1", change);
    await command("a", "run", options);
    const askId = await waitingFor();
    expect((await command("a", "approve", { askId, allow: true, always: "everything" })).status).toBe(400);
    expect((await command("a", "approve", { askId, allow: false, always: "changes" })).status).toBe(200);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).toBe(false));
    expect(fileOf("a").autoApprove).toBeUndefined();
  });
});

describe("autoapprove", () => {
  it("turns a kind on and off, and refuses a bad kind or value", async () => {
    saved("a");
    expect((await command("a", "autoapprove", { kind: "commands", on: true })).status).toBe(200);
    expect(fileOf("a").autoApprove).toEqual({ commands: true });
    expect((await command("a", "autoapprove", { kind: "changes", on: true })).status).toBe(200);
    expect(fileOf("a").autoApprove).toEqual({ commands: true, changes: true });
    expect((await command("a", "autoapprove", { kind: "commands", on: false })).status).toBe(200);
    expect(fileOf("a").autoApprove).toEqual({ changes: true });
    expect((await command("a", "autoapprove", { kind: "git", on: true })).status).toBe(400);
    expect((await command("a", "autoapprove", { kind: "commands", on: "yes" })).status).toBe(400);
  });
});

describe("a run in a session that approved something", () => {
  const ran = async (flags: object, ask: any) => {
    saved("a", { autoApprove: flags });
    askOn("a", "s1", ask);
    await command("a", "run", options);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).not.toBeUndefined());
    return askedAnswer("a", "s1");
  };

  it("approves that kind without asking", async () => {
    expect(await ran({ changes: true }, change)).toBe(true);
    expect(await ran({ commands: true }, shell)).toBe(true);
    expect(hub.liveRun("a")?.ask).toBeUndefined();
  });
});

describe("a run that approved something else still asks", () => {
  it("asks for a command when only changes are approved", async () => {
    saved("a", { autoApprove: { changes: true } });
    askOn("a", "s1", shell);
    await command("a", "run", options);
    await waitingFor();
    expect(askedAnswer("a", "s1")).toBeUndefined();
  });
});
