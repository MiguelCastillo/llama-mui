import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";
import { fakeRun, handles, makeSession, resetFakes } from "./fakeRun.ts";
import { putFile } from "./memorySessions.ts";

// Asks leave audit lines: raised, auto-approved by a session setting, dropped.
// The home folder is a temp one, so the real audit log is never touched.
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
const { auditDir, resetSeenSessions } = await import("../audit.ts");

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true, apiKey: "sk-secret" } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  modelOptions: {},
} as RunnerEnv;

let during: (h: RunnerHandle) => Promise<void> = async () => {};
let release: (ok: boolean) => void = () => {};

function fakeReply(h: RunnerHandle) {
  handles.set(h.sessionId, h);
  return async () => {
    const controller = new AbortController();
    h.setAbort(controller);
    try {
      await during(h);
      const ok = await new Promise<boolean>((resolve) => {
        release = resolve;
        if (controller.signal.aborted) resolve(false);
        controller.signal.addEventListener("abort", () => resolve(false));
      });
      return { ok, messages: [] };
    } finally {
      h.setAbort(null);
    }
  };
}

const save = (id: string, extra: object = {}) => putFile(id, { ...makeSession(id, 0), plan: null, messages: [], revision: 1, ...extra });
const turn = (id: string) => runners.startTurn(id, env, { text: "Go", planning: false }, { reply: fakeReply, save: (s) => hub.save(s.id, s) });

const lines = async (event: string) => {
  const names = await readdir(auditDir()).catch(() => [] as string[]);
  const all = (await Promise.all(names.map((n) => readFile(path.join(auditDir(), n), "utf8")))).flatMap((t) =>
    t.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  );
  return all.filter((l) => l.event === event);
};

const change = { type: "change", path: "/w/a.ts", action: "edit", diff: "SECRET-DIFF", reason: "fix it" };
const command = { type: "command", command: "npm i", cwd: "/w", readOnly: false };

beforeEach(async () => {
  // One home for the whole file: start each test with an empty audit.
  await rm(auditDir(), { recursive: true, force: true });
  resetFakes();
  during = async () => {};
  release = () => {};
  resetSeenSessions();
});
afterEach(async () => {
  await runners.resetRunners();
});

describe("asks in the audit", () => {
  it("records an ask when it is raised, with plain facts and never the diff", async () => {
    save("a");
    during = async (h) => {
      await h.askUser({ needsApproval: change } as any, new AbortController().signal);
    };
    const started = await turn("a");
    await vi.waitFor(() => expect(hub.liveRun("a")?.status).toBe("waiting"));
    const raised = await lines("ask.raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      session: "a",
      run: "turn",
      askId: hub.liveRun("a")!.ask!.id,
      ask: "approval",
      approval: "change",
      path: "/w/a.ts",
      action: "edit",
      reason: "fix it",
    });
    expect(JSON.stringify(raised[0])).not.toContain("SECRET-DIFF");
    await runners.answerAsk("a", hub.liveRun("a")!.ask!.id, true);
    release(true);
    await started.done;
  });

  it("records the facts of a command, an access and a page ask", async () => {
    const { askFacts } = runners;
    expect(askFacts({ needsApproval: command } as any)).toMatchObject({ approval: "command", command: "npm i", cwd: "/w", readOnly: false });
    expect(askFacts({ needsAccess: { path: "/x", kind: "folder" } } as any)).toEqual({ ask: "access", path: "/x", pathKind: "folder" });
    expect(askFacts({ needsApproval: { type: "page", url: "http://a.b/c", host: "a.b" } } as any)).toMatchObject({ host: "a.b", url: "http://a.b/c" });
  });

  it("records an auto-approved ask with the session setting that approved it", async () => {
    save("a", { autoApprove: { changes: true, commands: true } });
    let answers: unknown[] = [];
    during = async (h) => {
      const s = new AbortController().signal;
      answers = [await h.askUser({ needsApproval: change } as any, s), await h.askUser({ needsApproval: command } as any, s)];
    };
    const started = await turn("a");
    await vi.waitFor(() => expect(answers).toEqual([true, true]));
    const auto = await lines("ask.auto");
    expect(auto.map((l) => l.approvedBy)).toEqual(["session-setting:changes", "session-setting:commands"]);
    expect(auto[1]).toMatchObject({ session: "a", approved: true, command: "npm i", cwd: "/w" });
    expect(await lines("ask.raised")).toHaveLength(0);
    release(true);
    await started.done;
  });

  it("records an ask dropped by Stop as not approved", async () => {
    save("a");
    let answer: unknown = "none";
    during = async (h) => {
      answer = await h.askUser({ needsApproval: command } as any, new AbortController().signal);
    };
    const started = await turn("a");
    await vi.waitFor(() => expect(hub.liveRun("a")?.status).toBe("waiting"));
    const askId = hub.liveRun("a")!.ask!.id;
    await runners.stopRun("a");
    await started.done;
    expect(answer).toBe(false);
    const dropped = await lines("ask.dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ session: "a", askId, approved: false, command: "npm i" });
  });

  it("does not record a drop for an ask the user answered", async () => {
    save("a");
    during = async (h) => {
      await h.askUser({ needsApproval: command } as any, new AbortController().signal);
    };
    const started = await turn("a");
    await vi.waitFor(() => expect(hub.liveRun("a")?.status).toBe("waiting"));
    await runners.answerAsk("a", hub.liveRun("a")!.ask!.id, false);
    release(true);
    await started.done;
    expect(await lines("ask.dropped")).toHaveLength(0);
  });
});
