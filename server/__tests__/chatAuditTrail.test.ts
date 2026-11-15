import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";
import { handles, makeSession, resetFakes } from "./fakeRun.ts";
import { putFile } from "./memorySessions.ts";

// One search of a chat id finds everything the chat did: a tool call, a command,
// a fetch, a file write and a batched save. Lines from outside any chat (startup,
// background timers) have no chat id on purpose. The home folder is a temp one.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});
vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original<object>()));

const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");
const io = await import("../io/fs.ts");
const { execFile } = await import("../io/exec.ts");
const { auditedFetch } = await import("../io/fetch.ts");
const { audit, auditDir, resetSeenSessions } = await import("../audit.ts");
const { toolSpecs } = await import("../tools.ts");

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true, apiKey: "sk-secret" } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  modelOptions: {},
} as RunnerEnv;

let base = "";
const server = createServer((_req, res) => res.end("ok"));
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const allLines = async () => {
  const names = await readdir(auditDir()).catch(() => [] as string[]);
  const texts = await Promise.all(names.map((n) => readFile(path.join(auditDir(), n), "utf8")));
  return texts.flatMap((t) => t.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
};

const CHAT = "trail";
const sessionPath = path.join(home.dir, ".llama-mui", "sessions", CHAT, "session.json");
const usagePath = path.join(home.dir, ".llama-mui", "usage.jsonl");

function busyReply(h: RunnerHandle) {
  handles.set(h.sessionId, h);
  return async () => {
    const list = toolSpecs().find((t) => t.name === "list_todos")!;
    await list.run({ chatId: CHAT, todos: [] } as any, {});
    await execFile(process.execPath, ["-e", "0"], undefined, { why: "trail.exec" });
    await (await auditedFetch(`${base}/model`, undefined, { why: "trail.fetch" })).text();
    await io.mkdir(path.join(home.dir, "work"), { recursive: true }, { why: "trail.mkdir" });
    await io.write(path.join(home.dir, "work", "f.txt"), "x", undefined, { why: "trail.write" });
    await io.writeAtomicBatched(sessionPath, "{}", { mode: 0o600, dirMode: 0o700 }, { why: "trail.save" });
    await io.appendBatched(usagePath, "{}\n", { mode: 0o600, dirMode: 0o700 }, { why: "trail.usage" });
    return { ok: true, messages: [] };
  };
}

beforeEach(async () => {
  await rm(auditDir(), { recursive: true, force: true });
  resetFakes();
  resetSeenSessions();
});
afterEach(async () => {
  await runners.resetRunners();
});

describe("a chat's audit trail", () => {
  it("every line the chat caused carries its id, and background lines do not", async () => {
    // Background work with no chat: a startup line and a batched write.
    audit("server.start", { port: 1 });
    await io.appendBatched(path.join(home.dir, "background.log"), "b\n", { mode: 0o600, dirMode: 0o700 }, { why: "trail.background" });
    io.flushBatches();

    putFile(CHAT, { ...makeSession(CHAT, 0), plan: null, messages: [], revision: 1 });
    const started = await runners.startTurn(CHAT, env, { text: "Go", planning: false }, { reply: busyReply, save: (s) => hub.save(s.id, s) });
    await started.done;
    io.flushBatches(); // what the minute's timer would write

    const lines = await allLines();
    const mine = lines.filter((l) => String(l.why ?? "").startsWith("trail.") && l.why !== "trail.background");
    const whys = new Set(mine.map((l) => l.why));
    for (const w of ["trail.exec", "trail.fetch", "trail.mkdir", "trail.write", "trail.save", "trail.usage"]) expect(whys).toContain(w);
    for (const l of mine) expect(l.session, `${l.event} ${l.why}`).toBe(CHAT);

    // The tool call and the batch summaries for this chat's files name it too.
    expect(lines.find((l) => l.event === "tool.call" && l.tool === "list_todos")).toMatchObject({ session: CHAT });
    const batches = lines.filter((l) => l.event === "io.fs.batch" && l.why !== "trail.background");
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const b of batches) expect(b.session).toBe(CHAT);

    // Nothing from outside a chat picked one up.
    expect(lines.find((l) => l.event === "server.start")).not.toHaveProperty("session");
    expect(lines.find((l) => l.why === "trail.background")).not.toHaveProperty("session");
    expect(lines.filter((l) => l.event === "io.fs.batch" && l.why === "trail.background")[0]).not.toHaveProperty("session");
  });
});
