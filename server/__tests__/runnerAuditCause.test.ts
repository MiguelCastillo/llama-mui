import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";
import { handles, makeSession, resetFakes } from "./fakeRun.ts";
import { putFile } from "./memorySessions.ts";

// Everything a chat run does (a file write, a fetch, work started from a timer
// or a callback) leaves audit lines that carry the chat id. The home folder is a
// temp one, so the real audit log is never touched.
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
const { auditedFetch } = await import("../io/fetch.ts");
const { auditDir, resetSeenSessions } = await import("../audit.ts");

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

// A fake reply that does the kinds of work a real run does.
function workingReply(h: RunnerHandle) {
  handles.set(h.sessionId, h);
  return async () => {
    const target = path.join(home.dir, "work", `${h.sessionId}.txt`);
    await io.mkdir(path.dirname(target), { recursive: true }, { why: "test.mkdir" });
    await io.write(target, "x", undefined, { why: "test.write" });
    await (await auditedFetch(`${base}/model`, undefined, { why: "test.fetch" })).text();
    // Work started from a timer and from a callback keeps the chat id too.
    await new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        setImmediate(() => {
          io.write(`${target}.later`, "y", undefined, { why: "test.timer" }).then(() => resolve(), reject);
        });
      }, 5),
    );
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

describe("a chat run's audit lines", () => {
  it("every line written during the run carries the chat id", async () => {
    putFile("z", { ...makeSession("z", 0), plan: null, messages: [], revision: 1 });
    // Outside any run: no chat id.
    await io.write(path.join(home.dir, "outside.txt"), "o", undefined, { why: "test.outside" });

    const started = await runners.startTurn("z", env, { text: "Go", planning: false }, { reply: workingReply, save: (s) => hub.save(s.id, s) });
    await started.done;

    const lines = await allLines();
    const during = lines.filter((l) => ["test.mkdir", "test.write", "test.fetch", "test.timer"].includes(l.why));
    expect(during.map((l) => l.why).sort()).toEqual(["test.fetch", "test.mkdir", "test.timer", "test.write"]);
    for (const l of during) expect(l.session).toBe("z");

    // Anything else the run wrote (saves, ends) that has a chat id is the same chat.
    for (const l of lines.filter((l) => l.session !== undefined)) expect(String(l.session).split(":")[0]).toBe("z");
    // And the write made before the run has none.
    expect(lines.find((l) => l.why === "test.outside")).not.toHaveProperty("session");
  });
});
