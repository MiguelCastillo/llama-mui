import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer, Ask, RunnerEnv } from "../../src/runnerTypes.ts";
import { askOn, askedAnswer, fakeRun, finish, handles, makeSession, resetFakes, started } from "./fakeRun.ts";
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
const { SAVE_DELAY, SAVE_MAX_WAIT } = runners;

// No model and no server: the run is a fake that walks the plan the way
// runPlan does (see fakeRun.ts) and waits for the test to finish each step.
// Saving is a spy that goes to the hub, as the real one does.

const SECRET = "sk-secret-key";
const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true, apiKey: SECRET } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  thinkOn: false,
} as RunnerEnv;

const save = vi.fn((s: any) => hub.save(s.id, s));

// A saved session with `steps` pending steps, and a run on it.
async function start(id: string, steps = 3, deps: Parameters<typeof runners.startRunner>[2] = {}) {
  putFile(id, { ...makeSession(id, steps), revision: 1 });
  return runners.startRunner(id, env, {
    run: (cb) => fakeRun(id, cb),
    save,
    reply: (h) => {
      handles.set(h.sessionId, h);
      return async (_text, before) => ({ ok: true, messages: before });
    },
    ...deps,
  });
}

// Lets promises settle (timers are fake).
async function flush() {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
}

const run = (id: string) => hub.liveRun(id);
const statusOf = (id: string) => run(id)?.status;
// The run's own copy of the session, as it is now.
const live = (id: string) => handles.get(id)!.getSession();
const stepStatuses = (id: string) => live(id).plan!.map((s) => s.status);

let events: any[] = [];
let unsubscribe = () => {};
// The statuses a session's run went through, one after another ("over" when it ended).
const statuses = (id: string) =>
  events
    .filter((e) => e.id === id && e.type === "status")
    .map((e) => (e.data.run ? e.data.run.status : "over"))
    .filter((s, i, all) => s !== all[i - 1]);

beforeEach(() => {
  vi.useFakeTimers();
  resetFakes();
  save.mockClear();
  events = [];
  unsubscribe = hub.subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  await runners.resetRunners();
  files.clear();
  vi.useRealTimers();
});

const approval = { needsApproval: { name: "run_command" } } as unknown as Ask;
const reasonOf = async (p: Promise<unknown>) => p.then(() => null, (e) => ({ status: e.status, reason: e.extra?.reason }));

describe("start and status", () => {
  it("marks the session as running at once, and ends with every step done and the run gone", async () => {
    const { revision } = await start("a");
    expect(run("a")).toMatchObject({ status: "running" });
    // The hub has written the start: the file says the run is live, one revision on.
    expect(fileOf("a").run).toMatchObject({ status: "running" });
    expect(revision).toBe(2);
    expect(fileOf("a").revision).toBeGreaterThanOrEqual(revision);

    await flush();
    expect(started).toEqual(["s1"]);
    expect(run("a")!.streaming).toBe(true);
    expect(stepStatuses("a")).toEqual(["running", "pending", "pending"]);

    finish("a", "s1");
    await flush();
    finish("a", "s2");
    finish("a", "s3");
    await flush();
    expect(run("a")).toBeNull();
    expect(statuses("a")).toEqual(["running", "over"]);
    // The final session is the hub's last write, and the run record is gone from it.
    const saved = fileOf("a");
    expect(saved.plan.map((s: any) => s.status)).toEqual(["done", "done", "done"]);
    expect(saved.run).toBeUndefined();
    expect(saved.revision).toBeGreaterThan(2);
    expect(saved.planMovedIn).toBe(false);
  });

  it("resolves `done` when the run is over", async () => {
    const { done } = await start("a", 1);
    finish("a", "s1");
    await done;
    expect(run("a")).toBeNull();
  });

  it("refuses a second run of a session that is running (a second window), and allows one after it ends", async () => {
    await start("a", 1);
    expect(await reasonOf(runners.startRunner("a", env))).toEqual({ status: 409, reason: "already running" });
    expect(runners.isRunning("a")).toBe(true);
    finish("a", "s1");
    await flush();
    expect(runners.isRunning("a")).toBe(false);
    const again = await start("a", 1);
    expect(run("a")).toMatchObject({ status: "running" });
    expect(again.revision).toBeGreaterThan(0);
  });

  it("lets only one of two starts at the same moment through", async () => {
    putFile("a", { ...makeSession("a", 1), revision: 1 });
    const options = { run: (cb: any) => fakeRun("a", cb), save, reply: (h: any) => (handles.set("a", h), async (_t: string, b: any) => ({ ok: true, messages: b })) };
    const results = await Promise.allSettled([runners.startRunner("a", env, options), runners.startRunner("a", env, options)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as any).extra.reason).toBe("already running");
  });

  it("refuses a session that isn't saved, and a plan with no open step", async () => {
    expect(await reasonOf(runners.startRunner("nope", env))).toEqual({ status: 404, reason: undefined });
    const done = makeSession("d", 2);
    done.plan!.forEach((s) => (s.status = "done"));
    putFile("d", done);
    expect(await reasonOf(runners.startRunner("d", env))).toEqual({ status: 409, reason: "nothing to run" });
    expect(run("d")).toBeNull();
  });

  it("refuses to start from a copy that a save has already replaced", async () => {
    putFile("a", { ...makeSession("a", 1), revision: 1 });
    expect(await reasonOf(hub.beginRun("a", { expectRevision: 0 }))).toEqual({ status: 409, reason: "stale revision" });
    expect(run("a")).toBeNull();
  });

  it("tells pages of each change to a step, and of the session as patches", async () => {
    await start("a", 2);
    await flush();
    await vi.advanceTimersByTimeAsync(hub.SESSION_EVENT_MS);
    finish("a", "s1");
    await flush();
    await vi.advanceTimersByTimeAsync(hub.SESSION_EVENT_MS);

    const steps = events.filter((e) => e.type === "step").map((e) => `${e.data.step}:${e.data.status}`);
    expect(steps).toEqual(["s1:running", "s1:done", "s2:running"]);
    const patches = events.filter((e) => e.type === "session").map((e) => e.data.patch);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.at(-1).fields.plan.map((s: any) => s.status)).toEqual(["done", "running"]);
    // Never the whole chat per change.
    for (const p of patches) expect(p.messages).toBeUndefined();
  });

  it("keeps the connector and its key out of the session file, the events and the saves", async () => {
    await start("a", 1);
    await flush();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    finish("a", "s1");
    await flush();
    expect(save).toHaveBeenCalled();
    expect(JSON.stringify(save.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(fileOf("a"))).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain("apiKey");
  });

  it("an error from the run ends it, and the end says what went wrong", async () => {
    await start("a", 1, {
      run: async () => {
        throw new Error("boom");
      },
    });
    await flush();
    expect(run("a")).toBeNull();
    const last = events.filter((e) => e.type === "status").at(-1);
    expect(last.data).toEqual({ run: null, error: "boom" });
    expect(fileOf("a").run).toBeUndefined();
  });

  it("shows an error the run reports while it goes on", async () => {
    await start("a");
    await flush();
    handles.get("a")!.setError("The model isn't loaded");
    await flush();
    expect(run("a")).toMatchObject({ status: "running", error: "The model isn't loaded" });
    handles.get("a")!.setError(null);
    await flush();
    expect(run("a")!.error).toBeUndefined();
  });
});

describe("two sessions", () => {
  it("start while another session's run is still going: no global lock or limit", async () => {
    await start("a");
    await flush();
    expect(statusOf("a")).toBe("running");
    expect(run("a")!.streaming).toBe(true);

    // "a" is mid-step and has not been finished; "b" starts anyway.
    const second = await start("b", 2);
    await flush();
    expect(second.revision).toBeGreaterThan(0);
    expect(runners.isRunning("a")).toBe(true);
    expect(runners.isRunning("b")).toBe(true);
    expect(started).toEqual(["s1", "s1"]);
    expect(stepStatuses("a")).toEqual(["running", "pending", "pending"]);
    expect(stepStatuses("b")).toEqual(["running", "pending"]);

    // A third and a fourth too.
    await start("c", 1);
    await start("d", 1);
    await flush();
    expect(["a", "b", "c", "d"].every((id) => runners.isRunning(id))).toBe(true);
  });

  it("run independently", async () => {
    await start("a");
    await start("b", 2);
    await flush();
    expect(started).toEqual(["s1", "s1"]);

    finish("b", "s1");
    finish("b", "s2");
    await flush();
    expect(run("b")).toBeNull();
    expect(fileOf("b").plan.map((s: any) => s.status)).toEqual(["done", "done"]);
    expect(statusOf("a")).toBe("running");
    expect(stepStatuses("a")).toEqual(["running", "pending", "pending"]);

    finish("a", "s1");
    finish("a", "s2");
    finish("a", "s3");
    await flush();
    expect(run("a")).toBeNull();
    expect(fileOf("a").plan.map((s: any) => s.status)).toEqual(["done", "done", "done"]);
  });

  it("an ask in one doesn't hold the other", async () => {
    askOn("a", "s1", approval);
    await start("a", 1);
    await start("b", 2);
    await flush();
    expect(statusOf("a")).toBe("waiting");
    expect(statusOf("b")).toBe("running");

    finish("b", "s1");
    finish("b", "s2");
    await flush();
    expect(run("b")).toBeNull();
    expect(statusOf("a")).toBe("waiting");
  });

  it("stopping one leaves the other running", async () => {
    await start("a");
    await start("b");
    await flush();
    await runners.stopRun("a");
    expect(run("a")).toBeNull();
    expect(statusOf("b")).toBe("running");
    expect(run("b")!.streaming).toBe(true);
  });

  it("each session's events carry its own id", async () => {
    await start("a");
    await start("b");
    await flush();
    await runners.stopRun("b");
    expect(events.filter((e) => e.id === "a" && e.type === "status").every((e) => e.data.run !== null)).toBe(true);
    expect(events.filter((e) => e.id === "b" && e.type === "status").at(-1).data).toEqual({ run: null });
  });
});

describe("stop", () => {
  it("aborts the request, notes the step in flight 'Paused', and answers once the run is over", async () => {
    await start("a");
    await flush();
    await runners.stopRun("a");
    expect(run("a")).toBeNull();
    const saved = fileOf("a");
    const [s1, s2] = saved.plan;
    expect(s1.status).toBe("pending");
    expect(s1.note).toBe("Paused");
    expect(s2.note).toBeUndefined();
    expect(started).toEqual(["s1"]);
    expect(saved.run).toBeUndefined();
    expect(events.filter((e) => e.type === "status").at(-1).data).toEqual({ run: null });
  });

  it("releases a pending ask as a denial", async () => {
    askOn("a", "s1", approval);
    await start("a");
    await flush();
    expect(statusOf("a")).toBe("waiting");
    await runners.stopRun("a");
    expect(askedAnswer("a", "s1")).toBe(false);
    expect(run("a")).toBeNull();
    expect(fileOf("a").plan[0].note).toBe("Paused");
    expect(fileOf("a").run).toBeUndefined();
  });

  it("stopping twice is fine, and a stopped run is refused afterwards", async () => {
    await start("a");
    await flush();
    await Promise.all([runners.stopRun("a"), runners.stopRun("a")]);
    expect(await reasonOf(runners.stopRun("a"))).toEqual({ status: 409, reason: "not running" });
  });

  it("answers after STOP_WAIT_MS if the run won't end, and the run goes on stopping", async () => {
    let release!: () => void;
    await start("a", 1, { run: () => new Promise<void>((r) => (release = r)) });
    await flush();
    let answered = false;
    const stopping = runners.stopRun("a").then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(runners.STOP_WAIT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(run("a")).not.toBeNull();
    release();
    await flush();
    expect(run("a")).toBeNull();
  });
});

describe("saving", () => {
  it("waits for a quiet moment after the last change, and goes through the hub", async () => {
    await start("a");
    await flush();
    expect(save).not.toHaveBeenCalled();

    // The step started: that was a change, so a save is due SAVE_DELAY later.
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    handles.get("a")!.edit((s) => ({ ...s, title: "one" }));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    handles.get("a")!.edit((s) => ({ ...s, title: "two" }));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    expect(save).not.toHaveBeenCalled();

    const before = fileOf("a").revision;
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].title).toBe("two");
    // Written by the hub: the file has it, one revision on, the run record still there.
    expect(fileOf("a").title).toBe("two");
    expect(fileOf("a").revision).toBeGreaterThan(before);
    expect(fileOf("a").run).toBeDefined();
    expect(events.filter((e) => e.type === "saved").at(-1).data).toMatchObject({
      summary: { id: "a", title: "two" },
      revision: fileOf("a").revision,
    });

    // Nothing changed since: nothing more is saved.
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves at the latest SAVE_MAX_WAIT after the first change, however busy", async () => {
    await start("a");
    await flush();
    let n = 0;
    // A change every 700 ms never leaves a quiet 800 ms.
    while ((n + 1) * 700 < SAVE_MAX_WAIT) {
      handles.get("a")!.edit((s) => ({ ...s, title: `t${n++}` }));
      await vi.advanceTimersByTimeAsync(700);
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT - n * 700);
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("writes the final session itself when the run ends, and no timer saves it again", async () => {
    await start("a", 2);
    await flush();
    finish("a", "s1");
    await flush();
    expect(save).not.toHaveBeenCalled();
    finish("a", "s2");
    await flush();
    expect(run("a")).toBeNull();
    expect(fileOf("a").plan.map((s: any) => s.status)).toEqual(["done", "done"]);
    const revision = fileOf("a").revision;
    // No timer is left to write an older copy after it.
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT * 2);
    expect(save).not.toHaveBeenCalled();
    expect(fileOf("a").revision).toBe(revision);
  });

  it("shows a failed save as the run's error, and keeps running", async () => {
    const failing = vi.fn(async () => {
      throw new Error("disk full");
    });
    await start("a", 2, { save: failing });
    await flush();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    await flush();
    expect(run("a")!.error).toContain("disk full");
    expect(statusOf("a")).toBe("running");
  });
});

describe("changes from outside the run", () => {
  it("a rename through the hub goes into the live session, reaches pages, and survives the run's next save", async () => {
    await start("a", 1);
    await flush();
    await vi.advanceTimersByTimeAsync(hub.SESSION_EVENT_MS);
    events.length = 0;

    await hub.edit("a", (s) => {
      s.title = "renamed";
    });
    expect(live("a").title).toBe("renamed");
    await vi.advanceTimersByTimeAsync(hub.SESSION_EVENT_MS);
    expect(events.find((e) => e.type === "session")!.data.patch.fields).toEqual({ title: "renamed" });

    handles.get("a")!.edit((s) => ({ ...s, usage: { input: 1 } as any }));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    await flush();
    expect(fileOf("a").title).toBe("renamed");
    finish("a", "s1");
    await flush();
    expect(fileOf("a").title).toBe("renamed");
  });

  it("a page's own save is refused while the run lives, and works again after", async () => {
    await start("a", 1);
    await flush();
    expect(await reasonOf(hub.replace("a", () => makeSession("a", 1)))).toEqual({ status: 409, reason: "run active" });
    finish("a", "s1");
    await flush();
    await expect(hub.replace("a", () => makeSession("a", 1))).resolves.toMatchObject({ revision: expect.any(Number) });
  });
});
