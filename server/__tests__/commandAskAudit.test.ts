import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import type { CommandDeps } from "../commands.ts";
import { askOn, fakeRun, handles, makeSession, resetFakes } from "./fakeRun.ts";
import { files, putFile } from "./memorySessions.ts";

// Answers to asks, and changes to the session's auto-approve settings, leave
// audit lines. The home folder is a temp one.
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
const { auditDir, resetSeenSessions } = await import("../audit.ts");

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

async function command(id: string, name: string, body: unknown = {}, agent = "tab-1") {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "user-agent": agent },
  }) as unknown as IncomingMessage;
  const res = { statusCode: 200, setHeader() {}, end() {} } as unknown as ServerResponse;
  try {
    await commandRoutes({ req, res, parts: ["sessions", id, "commands", name], method: "POST", search: "" }, deps);
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
  return res.statusCode;
}

const lines = async (event: string) => {
  const names = await readdir(auditDir()).catch(() => [] as string[]);
  const all = (await Promise.all(names.map((n) => readFile(path.join(auditDir(), n), "utf8")))).flatMap((t) =>
    t.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  );
  return all.filter((l) => l.event === event);
};

const options = { connectorId: "c", model: "m", toolsOn: true, modelOptions: { think: false } };
const cmd = { needsApproval: { type: "command", command: "npm i", cwd: "/w", diff: "SECRET" } } as any;
const waiting = async () => {
  await vi.waitFor(() => expect(hub.liveRun("a")?.ask).toBeDefined());
  return hub.liveRun("a")!.ask!.id;
};
const start = async (ask: any = cmd) => {
  putFile("a", { ...makeSession("a", 1), revision: 1 });
  askOn("a", "s1", ask);
  await command("a", "run", options);
  return waiting();
};

beforeEach(async () => {
  await rm(auditDir(), { recursive: true, force: true });
  resetFakes();
  resetSeenSessions();
});
afterEach(async () => {
  await runners.resetRunners();
  files.clear();
});

describe("answers in the audit", () => {
  it("records a yes as answered by the user, with what was asked and who answered", async () => {
    const askId = await start();
    expect(await command("a", "approve", { askId, allow: true })).toBe(200);
    const [line] = await lines("ask.answered");
    expect(line).toMatchObject({
      session: "a",
      askId,
      decision: "allow",
      approved: true,
      approvedBy: "user",
      approval: "command",
      command: "npm i",
      cwd: "/w",
      who: { address: "127.0.0.1", agent: "tab-1" },
    });
    expect(JSON.stringify(line)).not.toContain("SECRET");
  });

  it("records a no as not approved", async () => {
    const askId = await start();
    await command("a", "approve", { askId, allow: false });
    expect((await lines("ask.answered"))[0]).toMatchObject({ decision: "deny", approved: false, approvedBy: "user" });
  });

  it("records picked paths with their kinds", async () => {
    const askId = await start({ needsLocation: { description: "the notes", kind: "folder" } });
    await command("a", "answer", { askId, paths: [{ path: "/notes", kind: "folder" }] });
    expect((await lines("ask.answered"))[0]).toMatchObject({ decision: "paths", paths: [{ path: "/notes", kind: "folder" }], ask: "location" });
  });

  it("records a stale second answer from another client as refused, and no second 'answered'", async () => {
    const askId = await start();
    await command("a", "approve", { askId, allow: true }, "tab-1");
    expect(await command("a", "approve", { askId, allow: false }, "tab-2")).toBe(409);
    expect(await lines("ask.answered")).toHaveLength(1);
    const refused = await lines("ask.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ session: "a", askId, reason: "stale ask", attempted: "deny", who: { agent: "tab-2" } });
  });

  it("records 'always' as a settings change, and the answer with the kind", async () => {
    const askId = await start();
    await command("a", "approve", { askId, allow: true, always: "commands" });
    expect((await lines("autoapprove.changed"))[0]).toMatchObject({ session: "a", kind: "commands", on: true, via: "always" });
    expect((await lines("ask.answered"))[0]).toMatchObject({ always: "commands", approved: true });
  });

  it("records the autoapprove chip turning a kind on and off", async () => {
    await start();
    await command("a", "autoapprove", { kind: "changes", on: true });
    await command("a", "autoapprove", { kind: "changes", on: false });
    const changed = await lines("autoapprove.changed");
    expect(changed.map((l) => [l.kind, l.on, l.via])).toEqual([
      ["changes", true, "autoapprove"],
      ["changes", false, "autoapprove"],
    ]);
  });
});
