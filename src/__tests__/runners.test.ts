import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PlanStep, Session, SessionSummary } from "../api";
import type { RunPlanCallbacks } from "../agent/agent";
import {
  type Answer,
  type Ask,
  type RunnerEnv,
  type RunnerEvent,
  type RunnerHandle,
  SAVE_DELAY,
  SAVE_MAX_WAIT,
  answerAsk,
  dismiss,
  edit,
  getView,
  needsYou,
  pause,
  pauseControl,
  resetRunners,
  resume,
  startRunner,
  stop,
  subscribe,
  subscribeAll,
} from "../runners";

// No model and no server: the run is a fake that walks the plan the way
// runPlan does (gate, step running, step done) and waits for the test to
// finish each step. Saving is a mock.

type Patch = Omit<PlanStep, "id" | "text">;
interface Deferred {
  promise: Promise<Patch | void>;
  resolve: (patch?: Patch) => void;
}

const jobs = new Map<string, Deferred>();
const asking = new Map<string, Ask>();
const answers = new Map<string, Answer>();
const handles = new Map<string, RunnerHandle>();
const started: string[] = [];

function job(key: string): Deferred {
  let d = jobs.get(key);
  if (!d) {
    let resolve!: Deferred["resolve"];
    const promise = new Promise<Patch | void>((r) => (resolve = r as Deferred["resolve"]));
    jobs.set(key, (d = { promise, resolve }));
  }
  return d;
}
// Lets step `step` of session `id` finish, with the given result (done by default).
const finish = (id: string, step: string, patch?: Patch) => job(`${id}/${step}`).resolve(patch);
// Makes the step ask before it works.
const askOn = (id: string, step: string, ask: Ask) => asking.set(`${id}/${step}`, ask);
const askedAnswer = (id: string, step: string) => answers.get(`${id}/${step}`);

async function fakeRun(id: string, cb: RunPlanCallbacks) {
  cb.planRunningRef.current = true;
  try {
    for (;;) {
      const next = cb.planRef.current?.find((s) => s.status === "pending");
      if (!next) break;
      if (cb.gate && !(await cb.gate())) break;
      const key = `${id}/${next.id}`;
      started.push(next.id);
      cb.setStep(next.id, { status: "running" });
      const c = new AbortController();
      cb.setAbort(c);
      let patch: Patch | void = undefined;
      try {
        const ask = asking.get(key);
        if (ask) answers.set(key, await handles.get(id)!.askUser(ask, c.signal));
        if (!c.signal.aborted) {
          patch = await Promise.race([
            job(key).promise,
            new Promise<void>((r) => c.signal.addEventListener("abort", () => r())),
          ]);
        }
      } finally {
        cb.setAbort(null);
      }
      if (c.signal.aborted) break;
      cb.setStep(next.id, patch ?? { status: "done" });
      if (patch && patch.status !== "done") break;
    }
  } finally {
    cb.planRunningRef.current = false;
  }
}

const SECRET = "sk-secret-key";
const env = {
  connector: { id: "c", apiKey: SECRET } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  thinkOn: false,
} as RunnerEnv;

function makeSession(id: string, steps = 3): Session {
  return {
    id,
    title: id,
    model: "m",
    messages: [],
    contextStart: 0,
    attachments: [],
    usage: null,
    failed: null,
    plan: Array.from({ length: steps }, (_, i) => ({ id: `s${i + 1}`, text: `Step ${i + 1}`, status: "pending" as const })),
  };
}

const save = vi.fn(async (s: Session): Promise<SessionSummary> => ({ id: s.id, title: s.title, updatedAt: 0 }));

function start(id: string, steps = 3, deps: Parameters<typeof startRunner>[2] = {}) {
  return startRunner(makeSession(id, steps), env, {
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
const statusOf = (id: string) => getView(id)?.status;
const stepStatuses = (id: string) => getView(id)!.session.plan!.map((s) => s.status);

beforeEach(() => {
  vi.useFakeTimers();
  jobs.clear();
  asking.clear();
  answers.clear();
  handles.clear();
  started.length = 0;
  save.mockClear();
});

afterEach(() => {
  resetRunners();
  vi.useRealTimers();
});

const approval = { needsApproval: { name: "run_command" } } as unknown as Ask;

describe("start and status", () => {
  it("starts running, and ends stopped with every step done", async () => {
    const view = start("a");
    expect(view.status).toBe("running");
    expect(getView("a")).toBe(view);
    await flush();
    expect(started).toEqual(["s1"]);
    expect(getView("a")!.streaming).toBe(true);
    expect(stepStatuses("a")).toEqual(["running", "pending", "pending"]);

    finish("a", "s1");
    await flush();
    finish("a", "s2");
    finish("a", "s3");
    await flush();
    expect(statusOf("a")).toBe("stopped");
    expect(stepStatuses("a")).toEqual(["done", "done", "done"]);
    expect(getView("a")!.streaming).toBe(false);
  });

  it("gives a new Session object for every change, and never changes the old one", async () => {
    const first = start("a").session;
    await flush();
    const second = getView("a")!.session;
    expect(second).not.toBe(first);
    expect(first.plan!.map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("tells the session's listeners about each change, and subscribeAll about status changes only", async () => {
    const seen: string[] = [];
    const events: string[] = [];
    subscribe("a", (v) => seen.push(v.status));
    subscribeAll((e) => events.push(`${e.kind}:${e.view?.status}`));
    start("a", 1);
    await flush();
    const before = events.length;
    edit("a", (s) => ({ ...s, title: "one" }));
    edit("a", (s) => ({ ...s, title: "two" }));
    expect(seen.length).toBeGreaterThan(2);
    expect(events.length).toBe(before); // plain edits are not announced
    finish("a", "s1");
    await flush();
    expect(events).toContain("status:running");
    expect(events).toContain("status:stopped");
  });

  it("leaves a running runner alone when started again, and replaces a stopped one", async () => {
    const view = start("a", 1);
    expect(start("a", 1)).toBe(view);
    finish("a", "s1");
    await flush();
    expect(statusOf("a")).toBe("stopped");
    const again = start("a", 1);
    expect(again.status).toBe("running");
    expect(getView("a")).toBe(again);
  });

  it("keeps the connector and its key out of the session", async () => {
    start("a", 1);
    await flush();
    finish("a", "s1");
    await flush();
    expect(save).toHaveBeenCalled();
    for (const [s] of save.mock.calls) expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(JSON.stringify(getView("a")!.session)).not.toContain(SECRET);
  });

  it("an error from the run ends it with the error shown", async () => {
    startRunner(makeSession("a"), env, {
      run: async () => {
        throw new Error("boom");
      },
      save,
    });
    await flush();
    expect(statusOf("a")).toBe("stopped");
    expect(getView("a")!.error).toBe("boom");
  });
});

describe("pause", () => {
  it("holds after the step in flight, and resume continues", async () => {
    const statuses: string[] = [];
    subscribeAll((e) => e.kind === "status" && statuses.push(e.view!.status));
    start("a");
    await flush();

    pause("a");
    expect(statusOf("a")).toBe("pausing");
    // The step in flight is not interrupted.
    expect(stepStatuses("a")).toEqual(["running", "pending", "pending"]);
    expect(getView("a")!.streaming).toBe(true);

    finish("a", "s1");
    await flush();
    expect(statusOf("a")).toBe("paused");
    expect(stepStatuses("a")).toEqual(["done", "pending", "pending"]);
    expect(started).toEqual(["s1"]);
    expect(getView("a")!.streaming).toBe(false);
    // Time passing doesn't start the next step.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toEqual(["s1"]);

    resume("a");
    await flush();
    expect(statusOf("a")).toBe("running");
    expect(started).toEqual(["s1", "s2"]);

    finish("a", "s2");
    finish("a", "s3");
    await flush();
    expect(stepStatuses("a")).toEqual(["done", "done", "done"]);
    expect(statuses).toEqual(["running", "pausing", "paused", "running", "stopped"]);
  });

  it("pausing and resuming before the step ends never holds", async () => {
    start("a");
    await flush();
    pause("a");
    resume("a");
    expect(statusOf("a")).toBe("running");
    finish("a", "s1");
    await flush();
    expect(started).toEqual(["s1", "s2"]);
    expect(statusOf("a")).toBe("running");
  });

  it("pause during an ask stays waiting, then pauses after the step", async () => {
    askOn("a", "s1", approval);
    start("a");
    await flush();
    expect(statusOf("a")).toBe("waiting");

    pause("a");
    expect(statusOf("a")).toBe("waiting");

    answerAsk("a", true);
    await flush();
    expect(askedAnswer("a", "s1")).toBe(true);
    expect(statusOf("a")).toBe("pausing");

    finish("a", "s1");
    await flush();
    expect(statusOf("a")).toBe("paused");
    expect(started).toEqual(["s1"]);
  });

  it("does nothing for a session without a runner or one that ended", async () => {
    expect(() => pause("nope")).not.toThrow();
    expect(() => resume("nope")).not.toThrow();
    start("a", 1);
    finish("a", "s1");
    await flush();
    pause("a");
    expect(statusOf("a")).toBe("stopped");
  });
});

describe("asks", () => {
  it("holds in waiting with the ask stored, and answerAsk continues", async () => {
    const events: string[] = [];
    subscribeAll((e) => events.push(e.kind));
    askOn("a", "s1", approval);
    start("a");
    await flush();

    const view = getView("a")!;
    expect(view.status).toBe("waiting");
    expect(view.ask?.ask).toBe(approval);
    expect(needsYou(view)).toBe(true);
    expect(events).toContain("ask");
    expect(askedAnswer("a", "s1")).toBeUndefined();

    answerAsk("a", true);
    await flush();
    expect(askedAnswer("a", "s1")).toBe(true);
    expect(statusOf("a")).toBe("running");
    expect(getView("a")!.ask).toBeNull();
    expect(needsYou(getView("a"))).toBe(false);
  });

  it("passes on what the user picked for a path", async () => {
    askOn("a", "s1", { needsLocation: { description: "the notes", kind: "folder" } });
    start("a", 1);
    await flush();
    const picked = [{ kind: "folder", path: "/x" }] as unknown as Answer;
    answerAsk("a", picked);
    await flush();
    expect(askedAnswer("a", "s1")).toBe(picked);
  });

  it("waits for as long as it takes", async () => {
    askOn("a", "s1", approval);
    start("a");
    await flush();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(statusOf("a")).toBe("waiting");
    expect(getView("a")!.ask).not.toBeNull();
  });

  it("an answer with nothing asked is ignored", async () => {
    start("a", 1);
    await flush();
    expect(() => answerAsk("a", true)).not.toThrow();
    expect(() => answerAsk("nope", true)).not.toThrow();
    expect(statusOf("a")).toBe("running");
  });
});

describe("two sessions", () => {
  it("run independently", async () => {
    start("a");
    start("b", 2);
    await flush();
    expect(started).toEqual(["s1", "s1"]);

    pause("a");
    finish("a", "s1");
    finish("b", "s1");
    finish("b", "s2");
    await flush();

    expect(statusOf("a")).toBe("paused");
    expect(stepStatuses("a")).toEqual(["done", "pending", "pending"]);
    expect(statusOf("b")).toBe("stopped");
    expect(stepStatuses("b")).toEqual(["done", "done"]);

    resume("a");
    finish("a", "s2");
    finish("a", "s3");
    await flush();
    expect(statusOf("a")).toBe("stopped");
    expect(stepStatuses("a")).toEqual(["done", "done", "done"]);
  });

  it("an ask in one doesn't hold the other", async () => {
    askOn("a", "s1", approval);
    start("a", 1);
    start("b", 2);
    await flush();
    expect(statusOf("a")).toBe("waiting");
    expect(needsYou(getView("a"))).toBe(true);
    expect(needsYou(getView("b"))).toBe(false);

    finish("b", "s1");
    finish("b", "s2");
    await flush();
    expect(statusOf("b")).toBe("stopped");
    expect(statusOf("a")).toBe("waiting");
  });

  it("stopping one leaves the other running", async () => {
    start("a");
    start("b");
    await flush();
    stop("a");
    await flush();
    expect(statusOf("a")).toBe("stopped");
    expect(statusOf("b")).toBe("running");
    expect(getView("b")!.streaming).toBe(true);
  });

  it("each listener hears only its own session", async () => {
    const a: string[] = [];
    subscribe("a", (v) => a.push(v.sessionId));
    start("b");
    await flush();
    expect(a).toEqual([]);
  });
});

describe("stop", () => {
  it("aborts the request and notes the step in flight 'Stopped'", async () => {
    start("a");
    await flush();
    stop("a");
    await flush();
    const view = getView("a")!;
    expect(view.status).toBe("stopped");
    expect(view.streaming).toBe(false);
    const [s1, s2] = view.session.plan!;
    expect(s1.status).toBe("pending");
    expect(s1.note).toBe("Stopped");
    expect(s2.note).toBeUndefined();
    expect(started).toEqual(["s1"]);
    // The final session is saved.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].plan![0].note).toBe("Stopped");
  });

  it("releases a pause", async () => {
    start("a");
    await flush();
    pause("a");
    finish("a", "s1");
    await flush();
    expect(statusOf("a")).toBe("paused");

    stop("a");
    await flush();
    expect(statusOf("a")).toBe("stopped");
    expect(stepStatuses("a")).toEqual(["done", "pending", "pending"]);
    expect(getView("a")!.session.plan![1].note).toBeUndefined();
    expect(started).toEqual(["s1"]);
  });

  it("releases a pending ask as a denial", async () => {
    askOn("a", "s1", approval);
    start("a");
    await flush();
    expect(statusOf("a")).toBe("waiting");
    stop("a");
    await flush();
    expect(askedAnswer("a", "s1")).toBe(false);
    expect(statusOf("a")).toBe("stopped");
    expect(getView("a")!.ask).toBeNull();
    expect(getView("a")!.session.plan![0].note).toBe("Stopped");
  });

  it("does nothing twice", async () => {
    start("a");
    await flush();
    stop("a");
    stop("a");
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("an entry that stopped can be dismissed, and then is gone", async () => {
    const events: RunnerEvent[] = [];
    start("a", 1);
    await flush();
    subscribeAll((e) => events.push(e));
    stop("a");
    await flush();
    save.mockClear();
    edit("a", (s) => ({ ...s, title: "last" }));
    await dismiss("a");
    expect(getView("a")).toBeUndefined();
    // The last change was saved first.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].title).toBe("last");
    expect(events.at(-1)).toMatchObject({ id: "a", kind: "dismissed", view: null });
  });

  it("dismissing a run that is going stops it without saving more", async () => {
    start("a");
    await flush();
    await dismiss("a");
    await flush();
    expect(getView("a")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT * 2);
    expect(save).not.toHaveBeenCalled();
    expect(started).toEqual(["s1"]);
  });
});

describe("needsYou", () => {
  it("is false for nothing and for a plain running view", async () => {
    expect(needsYou(undefined)).toBe(false);
    expect(needsYou(null)).toBe(false);
    start("a", 1);
    await flush();
    expect(needsYou(getView("a"))).toBe(false);
  });

  it("is true for a pending ask", async () => {
    askOn("a", "s1", approval);
    start("a", 1);
    await flush();
    expect(needsYou(getView("a"))).toBe(true);
  });

  it("is true when it stopped with a waiting step, false for other stops", async () => {
    start("a");
    await flush();
    finish("a", "s1", { status: "waiting", note: "Which file?" });
    await flush();
    expect(statusOf("a")).toBe("stopped");
    expect(stepStatuses("a")).toEqual(["waiting", "pending", "pending"]);
    expect(needsYou(getView("a"))).toBe(true);

    start("b", 1);
    await flush();
    stop("b");
    await flush();
    expect(statusOf("b")).toBe("stopped");
    expect(needsYou(getView("b"))).toBe(false);
  });
});

describe("pauseControl", () => {
  it("offers Pause only while running", () => {
    expect(pauseControl("running")).toEqual({ text: null, button: "Pause" });
  });
  it("says Pausing after this step, without a button", () => {
    expect(pauseControl("pausing")).toEqual({ text: "Pausing after this step", button: null });
  });
  it("says Paused and offers Resume", () => {
    expect(pauseControl("paused")).toEqual({ text: "Paused", button: "Resume" });
  });
  it("offers nothing while waiting, stopped or without a runner", () => {
    for (const s of ["waiting", "stopped", undefined, null] as const) {
      expect(pauseControl(s)).toEqual({ text: null, button: null });
    }
  });
});

describe("saving", () => {
  it("waits for a quiet moment after the last change", async () => {
    start("a");
    await flush();
    expect(save).not.toHaveBeenCalled();

    // The step started: that was a change, so a save is due SAVE_DELAY later.
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    edit("a", (s) => ({ ...s, title: "one" }));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    edit("a", (s) => ({ ...s, title: "two" }));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].title).toBe("two");

    // Nothing changed since: nothing more is saved.
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves at the latest SAVE_MAX_WAIT after the first change, however busy", async () => {
    start("a");
    await flush();
    let n = 0;
    // A change every 700 ms never leaves a quiet 800 ms.
    while ((n + 1) * 700 < SAVE_MAX_WAIT) {
      edit("a", (s) => ({ ...s, title: `t${n++}` }));
      await vi.advanceTimersByTimeAsync(700);
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT - n * 700);
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flushes when the run ends, without waiting", async () => {
    start("a", 2);
    await flush();
    finish("a", "s1");
    await flush();
    expect(save).not.toHaveBeenCalled();
    finish("a", "s2");
    await flush();
    expect(statusOf("a")).toBe("stopped");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].plan!.map((s) => s.status)).toEqual(["done", "done"]);
    // No timer is left to save it again.
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("announces a save with the saved row", async () => {
    const saved: RunnerEvent[] = [];
    subscribeAll((e) => e.kind === "saved" && saved.push(e));
    start("a", 1);
    await flush();
    finish("a", "s1");
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0].summary).toMatchObject({ id: "a" });
  });

  it("saves one at a time, the newest last", async () => {
    let release!: () => void;
    const slow = vi.fn(
      (s: Session) =>
        new Promise<SessionSummary>((resolve) => {
          release = () => resolve({ id: s.id, title: s.title, updatedAt: 0 });
        }),
    );
    start("a", 2, { save: slow });
    await flush();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    expect(slow).toHaveBeenCalledTimes(1);

    // The run ends while the first save is still under way.
    finish("a", "s1");
    finish("a", "s2");
    await flush();
    expect(statusOf("a")).toBe("stopped");
    expect(slow).toHaveBeenCalledTimes(1);

    release();
    await flush();
    expect(slow).toHaveBeenCalledTimes(2);
    expect(slow.mock.calls[1][0].plan!.map((s) => s.status)).toEqual(["done", "done"]);
    release();
    await flush();
  });

  it("shows a failed save as the runner's error, and keeps running", async () => {
    const failing = vi.fn(async () => {
      throw new Error("disk full");
    });
    start("a", 2, { save: failing });
    await flush();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    await flush();
    expect(getView("a")!.error).toContain("disk full");
    expect(statusOf("a")).toBe("running");
  });
});

describe("edit", () => {
  it("changes the live session and is saved with it", async () => {
    start("a", 1);
    await flush();
    const before = getView("a")!.session;
    edit("a", (s) => ({ ...s, title: "renamed" }));
    expect(getView("a")!.session).not.toBe(before);
    expect(getView("a")!.session.title).toBe("renamed");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    await flush();
    expect(save.mock.calls.at(-1)![0].title).toBe("renamed");
  });

  it("returning the same session changes nothing", async () => {
    start("a", 1);
    await flush();
    const view = getView("a");
    edit("a", (s) => s);
    expect(getView("a")).toBe(view);
  });

  it("is ignored without a runner", () => {
    expect(() => edit("nope", (s) => s)).not.toThrow();
  });
});
