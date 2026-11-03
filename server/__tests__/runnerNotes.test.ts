import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import { fakeRun, finish, handles, makeSession, promptNotes, resetFakes } from "./fakeRun.ts";
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

const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");

// Messages from the user to a running plan: folded in before the next step,
// acknowledged with the step that sees it, refused when none is left. The run
// is a fake that walks the plan the way runPlan does (see fakeRun.ts); no model.

const SECRET = "sk-secret-key";
const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true, apiKey: SECRET } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  thinkOn: false,
} as RunnerEnv;

async function start(id: string, steps = 3) {
  putFile(id, { ...makeSession(id, steps), revision: 1 });
  return runners.startRunner(id, env, {
    run: (cb) => fakeRun(id, cb),
    save: (s) => hub.save(s.id, s),
    reply: (h) => {
      handles.set(h.sessionId, h);
      return async (_text, before) => ({ ok: true, messages: before });
    },
  });
}

async function flush() {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
}

const live = (id: string) => handles.get(id)!.getSession();
const reasonOf = async (p: Promise<unknown>) => p.then(() => null, (e) => ({ status: e.status, reason: e.extra?.reason }));
const userMessages = (id: string) => live(id).messages.filter((m) => m.role === "user");

let events: any[] = [];
let unsubscribe = () => {};
const acks = (id = "a") => events.filter((e) => e.id === id && e.type === "ack").map((e) => e.data);

beforeEach(() => {
  vi.useFakeTimers();
  resetFakes();
  events = [];
  unsubscribe = hub.subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  await runners.resetRunners();
  files.clear();
  vi.useRealTimers();
});

describe("a message to a running plan", () => {
  it("is acknowledged at once with the step that will see it, and joins the chat when that step starts", async () => {
    await start("a", 3);
    await flush(); // step 1 is in flight

    const r = await runners.sendNote("a", "  Use tabs, not spaces ");
    expect(r).toMatchObject({ step: 2, stepId: "s2" });
    expect(acks()).toEqual([{ messageId: r.messageId, text: "Use tabs, not spaces", step: 2, stepId: "s2" }]);
    // Not in the chat yet, and no step has it: it waits for the boundary.
    expect(userMessages("a")).toEqual([]);
    expect(promptNotes.get("a/s1")).toEqual([]);
    expect(hub.liveRun("a")!.notes).toEqual([{ id: r.messageId, text: "Use tabs, not spaces", step: 2, stepId: "s2" }]);

    finish("a", "s1");
    await flush();
    // Step 2 started: the message is in the chat, marked with the step, in its prompt.
    expect(userMessages("a")).toEqual([{ role: "user", content: "Use tabs, not spaces", seenByStep: 2 }]);
    expect(promptNotes.get("a/s2")).toEqual(["Use tabs, not spaces"]);
    expect(hub.liveRun("a")!.notes).toBeUndefined();
    // No second ack: the step was the one promised.
    expect(acks()).toHaveLength(1);

    // Later steps start fresh too, so they get it as well.
    finish("a", "s2");
    await flush();
    expect(promptNotes.get("a/s3")).toEqual(["Use tabs, not spaces"]);
    expect(userMessages("a")).toHaveLength(1);
  });

  it("goes to the next step while the run is paused, and is there when it resumes", async () => {
    await start("a", 3);
    await flush();
    await runners.pauseRun("a");
    finish("a", "s1");
    await flush();
    expect(hub.liveRun("a")!.status).toBe("paused");
    expect(userMessages("a")).toEqual([]);

    const r = await runners.sendNote("a", "Skip the tests");
    expect(r).toMatchObject({ step: 2, stepId: "s2" });
    // The hold is before the boundary: nothing is folded in while it holds.
    expect(userMessages("a")).toEqual([]);
    await runners.resumeRun("a");
    await flush();
    expect(promptNotes.get("a/s2")).toEqual(["Skip the tests"]);
    expect(userMessages("a")[0]).toMatchObject({ content: "Skip the tests", seenByStep: 2 });
  });

  it("keeps several messages in the order they came, all at the same boundary", async () => {
    await start("a", 3);
    await flush();
    await runners.sendNote("a", "first");
    await runners.sendNote("a", "second");
    finish("a", "s1");
    await flush();
    expect(userMessages("a").map((m) => m.content)).toEqual(["first", "second"]);
    expect(promptNotes.get("a/s2")).toEqual(["first", "second"]);
  });

  it("is refused when the step in flight is the last one, and nothing is queued", async () => {
    await start("a", 2);
    await flush();
    finish("a", "s1");
    await flush(); // step 2, the last, is in flight
    const refused = runners.sendNote("a", "One more thing");
    expect(await reasonOf(refused)).toEqual({ status: 409, reason: "no step left" });
    await expect(runners.sendNote("a", "One more thing")).rejects.toThrow(/last one is already running/);
    expect(hub.liveRun("a")!.notes).toBeUndefined();
    expect(acks()).toEqual([]);
    finish("a", "s2");
    await flush();
    // The run ended with nothing in the chat that wasn't sent to a step.
    expect(fileOf("a").messages).toEqual([]);
  });

  it("is refused while the run is stopping", async () => {
    await start("a", 3);
    await flush();
    const stopping = runners.stopRun("a");
    expect(await reasonOf(runners.sendNote("a", "wait"))).toEqual({ status: 409, reason: "no step left" });
    await flush();
    await stopping;
  });

  it("is refused when no plan runs, and an empty message is refused", async () => {
    putFile("a", { ...makeSession("a", 2), revision: 1 });
    expect(await reasonOf(runners.sendNote("a", "hi"))).toEqual({ status: 409, reason: "not running" });
    await start("a", 3);
    await flush();
    expect(await reasonOf(runners.sendNote("a", "   "))).toEqual({ status: 400, reason: undefined });
  });

  it("is put in the chat as not seen when the plan ends before another step starts, never lost", async () => {
    await start("a", 3);
    await flush();
    const r = await runners.sendNote("a", "Please use tabs");
    // Step 1 fails: the plan stops, and no step ever starts to see the message.
    finish("a", "s1", { status: "failed", note: "It broke" });
    await flush();
    expect(hub.liveRun("a")).toBeNull();
    expect(acks()).toEqual([
      { messageId: r.messageId, text: "Please use tabs", step: 2, stepId: "s2" },
      {
        messageId: r.messageId,
        text: "Please use tabs",
        step: null,
        reason: "The plan ended before another step started, so no step saw this message.",
      },
    ]);
    const saved = fileOf("a");
    expect(saved.run).toBeUndefined();
    expect(saved.messages).toEqual([{ role: "user", content: "Please use tabs", notSeen: true }]);
    expect(promptNotes.get("a/s2")).toBeUndefined();
  });

  it("is also put in the chat as not seen when Stop ends the run", async () => {
    await start("a", 3);
    await flush();
    await runners.sendNote("a", "Never mind the docs");
    await runners.stopRun("a");
    expect(acks().at(-1)).toMatchObject({
      step: null,
      reason: "The plan was stopped before another step started, so no step saw this message.",
    });
    expect(fileOf("a").messages).toEqual([{ role: "user", content: "Never mind the docs", notSeen: true }]);
  });

  it("is acknowledged again if a different step than the promised one starts", async () => {
    await start("a", 3);
    await flush();
    await runners.sendNote("a", "heads up"); // promised to step 2
    // The user edits the plan meanwhile: step 2 is gone.
    handles.get("a")!.edit((s) => ({ ...s, plan: s.plan!.filter((st) => st.id !== "s2") }));
    finish("a", "s1");
    await flush();
    expect(acks().at(-1)).toMatchObject({ step: 2, stepId: "s3" });
    expect(userMessages("a")[0]).toMatchObject({ content: "heads up", seenByStep: 2 });
    expect(promptNotes.get("a/s3")).toEqual(["heads up"]);
  });

  it("puts nothing secret in the events or the saved session", async () => {
    await start("a", 3);
    await flush();
    await runners.sendNote("a", "plain words");
    finish("a", "s1");
    await flush();
    finish("a", "s2");
    finish("a", "s3");
    await flush();
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(fileOf("a"))).not.toContain(SECRET);
  });
});

describe("closing the server", () => {
  it("stopAllRuns ends every run properly, with its last save", async () => {
    await start("a", 2);
    await start("b", 2);
    await flush();
    expect(hub.liveRuns().map((r) => r.id).sort()).toEqual(["a", "b"]);
    await runners.stopAllRuns();
    expect(hub.liveRuns()).toEqual([]);
    // The step that was in flight is back to pending, noted as stopped, and saved that way.
    expect(fileOf("a").plan[0]).toMatchObject({ status: "pending", note: "Stopped" });
    expect(fileOf("a").run).toBeUndefined();
    expect(fileOf("b").plan[0]).toMatchObject({ status: "pending", note: "Stopped" });
  });
});
