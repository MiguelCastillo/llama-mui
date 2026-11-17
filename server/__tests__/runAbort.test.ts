import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";
import { endKindOf, isEndKind } from "../../src/runEnd.ts";
import { fakeRun, handles, makeSession, resetFakes } from "./fakeRun.ts";
import { fileOf, putFile } from "./memorySessions.ts";

// Every cut-off of a run's request logs a run.abort line naming the kind, and
// the request's signal carries the same kind as its reason. The home folder is
// a temp one, so the real log is never touched.
const home = vi.hoisted(() => ({ dir: "", lostFloor: (_id: string) => {} }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});
vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original<object>()));
// Keeps hold of the handler the runners register, so a test can say "another server took the floor".
vi.mock("../runHub.ts", async (original) => {
  const real = await original<typeof import("../runHub.ts")>();
  return {
    ...real,
    setLostFloorHandler: (fn: (id: string) => void) => {
      home.lostFloor = fn;
      real.setLostFloorHandler(fn);
    },
  };
});

const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");
const { auditDir, resetSeenSessions } = await import("../audit.ts");
const { logClose } = await import("../lifecycle.ts");
const logs = await import("../log.ts");

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true, apiKey: "sk-secret" } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  modelOptions: {},
} as RunnerEnv;

let signals: Record<string, AbortSignal> = {};
let release: () => void = () => {};

function fakeReply(h: RunnerHandle) {
  handles.set(h.sessionId, h);
  return async () => {
    const controller = new AbortController();
    signals[h.sessionId] = controller.signal;
    h.setAbort(controller);
    try {
      await new Promise<void>((resolve) => {
        release = resolve;
        controller.signal.addEventListener("abort", () => resolve());
      });
      return { ok: false, messages: [] };
    } finally {
      h.setAbort(null);
    }
  };
}

const save = (id: string) => putFile(id, { ...makeSession(id, 0), plan: null, messages: [], revision: 1 });
const turn = (id: string) => runners.startTurn(id, env, { text: "Go", planning: false }, { reply: fakeReply, save: (s) => hub.save(s.id, s) });

const aborts = async () => {
  const names = await readdir(auditDir()).catch(() => [] as string[]);
  const all = (await Promise.all(names.map((n) => readFile(path.join(auditDir(), n), "utf8")))).flatMap((t) =>
    t.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  );
  return all.filter((l) => l.event === "run.abort");
};

beforeEach(async () => {
  await rm(auditDir(), { recursive: true, force: true });
  resetFakes();
  signals = {};
  resetSeenSessions();
});
afterEach(async () => {
  release();
  await runners.resetRunners();
});

describe("run.abort", () => {
  it("knows the kinds", () => {
    expect(["stopped", "restart", "taken-over"].every(isEndKind)).toBe(true);
    expect(isEndKind("other")).toBe(false);
    expect(endKindOf(new AbortController().signal)).toBeNull();
  });

  it("Stop logs stopped, and the signal says so", async () => {
    save("a");
    const started = await turn("a");
    await vi.waitFor(() => expect(signals.a).toBeDefined());
    await runners.stopRun("a");
    await started.done;
    expect(endKindOf(signals.a)).toBe("stopped");
    expect(await aborts()).toEqual([expect.objectContaining({ session: "a", kind: "stopped", open: "request", request: "reply" })]);
  });

  it("closing the server's runs logs restart for each", async () => {
    save("a");
    save("b");
    const [x, y] = [await turn("a"), await turn("b")];
    await vi.waitFor(() => expect(Object.keys(signals)).toHaveLength(2));
    await runners.stopAllRuns();
    await Promise.all([x.done, y.done]);
    expect(endKindOf(signals.a)).toBe("restart");
    expect(endKindOf(signals.b)).toBe("restart");
    const logged = await aborts();
    expect(logged.map((l) => [l.session, l.kind]).sort()).toEqual([["a", "restart"], ["b", "restart"]]);
  });

  it("losing the floor to another server logs taken-over", async () => {
    save("a");
    const started = await turn("a");
    await vi.waitFor(() => expect(signals.a).toBeDefined());
    home.lostFloor("a");
    expect(endKindOf(signals.a)).toBe("taken-over");
    expect(await aborts()).toEqual([expect.objectContaining({ session: "a", kind: "taken-over", open: "request" })]);
    release();
    await started.done.catch(() => {});
  });

  it("saves a stop with the chat", async () => {
    save("stop1");
    const started = await turn("stop1");
    await vi.waitFor(() => expect(signals.stop1).toBeDefined());
    await runners.stopRun("stop1");
    await started.done;
    expect(fileOf("stop1").endedBy).toBe("stopped");
  });

  it("writes the kind into the run record as soon as the run is cut short", async () => {
    save("rec1");
    const started = await turn("rec1");
    await vi.waitFor(() => expect(signals.rec1).toBeDefined());
    expect(hub.liveRun("rec1")?.endedBy).toBeUndefined();
    const stopping = runners.stopRun("rec1");
    await vi.waitFor(() => expect(hub.liveRun("rec1")?.endedBy ?? "gone").not.toBeUndefined());
    await stopping;
    await started.done;
  });

  it("saves a restart with the chat", async () => {
    save("b");
    const started = await turn("b");
    await vi.waitFor(() => expect(signals.b).toBeDefined());
    await runners.stopAllRuns();
    await started.done;
    expect(fileOf("b").endedBy).toBe("restart");
  });

  it("the close line names the chats whose runs were still going, and why", async () => {
    const lines: any[] = [];
    const spy = vi.spyOn(logs, "log").mockImplementation((event: string, fields: any) => void lines.push({ event, ...fields }));
    save("x2");
    save("x1");
    const [p, q] = [await turn("x2"), await turn("x1")];
    await vi.waitFor(() => expect(signals.x1 && signals.x2).toBeDefined());
    expect(runners.liveRunIds()).toEqual(["x1", "x2"]);
    logClose("dev");
    logClose("prod");
    spy.mockRestore();
    expect(lines).toEqual([
      expect.objectContaining({ event: "server.close", runs: ["x1", "x2"], reason: "reload" }),
      expect.objectContaining({ event: "server.close", runs: ["x1", "x2"], reason: "restart" }),
    ]);
    await runners.stopAllRuns();
    await Promise.all([p.done, q.done]);
    expect(runners.liveRunIds()).toEqual([]);
  });

  it("logs no reply text", async () => {
    save("c");
    const started = await turn("c");
    await vi.waitFor(() => expect(signals.c).toBeDefined());
    await runners.stopRun("c");
    await started.done;
    expect(Object.keys((await aborts())[0]).sort()).toEqual(
      expect.arrayContaining(["event", "session", "kind", "open"]),
    );
    expect(JSON.stringify(await aborts())).not.toContain("Go");
  });
});
