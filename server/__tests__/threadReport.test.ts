import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportInput } from "../../src/agent/threadReport.ts";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import { fakeRun, finish, handles, makeSession, resetFakes } from "./fakeRun.ts";
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
const { reportToParent, REPORT_TIMEOUT_MS } = await import("../threadReport.ts");

// No model: the plan's run and the report's request are fakes. The rest (the
// hub, the runner, the writes to the parent) is the real thing.

const SECRET = "sk-secret-key";
const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  thinkOn: false,
} as RunnerEnv;

type Ask = (input: ReportInput, env: RunnerEnv, signal: AbortSignal) => Promise<string | null>;
const asked: ReportInput[] = [];
const model = (answer: string | null): Ask =>
  vi.fn(async (input) => {
    asked.push(input);
    return answer;
  });

const NOTE = { sessionId: "kid", summary: "Do two things", anchor: "call-1", planId: "plan-1" };
const request = { role: "user", content: "Please do two things" };

function parentSession(extra: object = {}) {
  putFile("p", {
    ...makeSession("p", 0),
    plan: null,
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "Here is a plan." }],
    threads: [NOTE],
    revision: 5,
    ...extra,
  });
}
function threadSession(extra: object = {}) {
  putFile("kid", {
    ...makeSession("kid", 2),
    parentId: "p",
    planSummary: "Do two things",
    planId: "plan-1",
    messages: [request],
    revision: 1,
    ...extra,
  });
}

// Runs the thread's plan with fakes, and answers with what the runner gives back.
const startThread = (report: Ask) =>
  runners.startRunner("kid", env, {
    run: (cb) => fakeRun("kid", cb),
    reply: (h) => {
      handles.set(h.sessionId, h);
      return async (_text, before) => ({ ok: true, messages: before });
    },
    report,
  });

const thread = () => fileOf("p").threads[0];
const threadEvents = (events: any[]) => events.filter((e) => e.type === "thread").map((e) => e.data);
const settle = (id: string) => vi.waitFor(() => expect(hub.liveRun(id)).toBeNull());

let events: any[] = [];
let unsubscribe = () => {};
beforeEach(() => {
  resetFakes();
  asked.length = 0;
  events = [];
  unsubscribe = hub.subscribe((e) => events.push(e));
});
afterEach(async () => {
  unsubscribe();
  await runners.resetRunners();
  files.clear();
  vi.useRealTimers();
});

describe("a thread reports to its parent when its run ends", () => {
  it("sets done and the model's report on the note, in two writes", async () => {
    parentSession();
    threadSession();
    const { finished } = await startThread(model("It made both changes. The tests pass."));
    // While the run is live the note has no outcome yet.
    expect(thread()).toEqual(NOTE);

    await vi.waitFor(() => expect(hub.liveRun("kid")?.streaming).toBe(true));
    finish("kid", "s1");
    await vi.waitFor(() => expect(fileOf("kid").plan[0].status).toBe("done"));
    finish("kid", "s2");
    await finished;

    expect(thread()).toMatchObject({ ...NOTE, status: "done", report: { text: "It made both changes. The tests pass." } });
    expect(thread().report.at).toBeGreaterThan(0);
    // Two owner-edits: the revision went up by two, and pages heard of each.
    expect(fileOf("p").revision).toBe(7);
    expect(threadEvents(events)).toEqual([
      { sessionId: "kid", planId: "plan-1", status: "done", report: null, revision: 6 },
      { sessionId: "kid", planId: "plan-1", status: "done", report: { text: "It made both changes. The tests pass.", at: thread().report.at }, revision: 7 },
    ]);
    // The first write came before the second, and each was announced as saved.
    expect(events.filter((e) => e.id === "p" && e.type === "saved").map((e) => e.data.revision)).toEqual([6, 7]);
    // The thread's own run was over before it reported.
    expect(hub.liveRun("kid")).toBeNull();
  });

  it("copies none of the thread's messages, only the status and the report", async () => {
    parentSession();
    threadSession({ messages: [request, { role: "assistant", content: "SECRET-THREAD-TEXT" }] });
    const { finished } = await startThread(model("Done."));
    finish("kid", "s1");
    finish("kid", "s2");
    await finished;
    const parent = fileOf("p");
    expect(parent.messages).toEqual([{ role: "user", content: "hello" }, { role: "assistant", content: "Here is a plan." }]);
    expect(JSON.stringify(parent)).not.toContain("SECRET-THREAD-TEXT");
    expect(parent.plan).toBeNull();
    expect(Object.keys(parent.threads[0]).sort()).toEqual(["anchor", "planId", "report", "sessionId", "status", "summary"]);
  });

  it("shows the model the request, the steps and how each ended, and its last words", async () => {
    parentSession();
    threadSession({ messages: [request, { role: "assistant", content: "I changed a.ts and b.ts." }] });
    const { finished } = await startThread(model("It did."));
    finish("kid", "s1");
    await vi.waitFor(() => expect(fileOf("kid").plan[0].status).toBe("done"));
    finish("kid", "s2", { status: "failed", note: "npm test failed: 2 errors" });
    await finished;

    expect(asked).toHaveLength(1);
    const input = asked[0]!;
    expect(input).toMatchObject({ summary: "Do two things", request: "Please do two things", stopped: false });
    expect(input.steps.map((s) => s.status)).toEqual(["done", "failed"]);
    expect(input.steps[1]!.note).toBe("npm test failed: 2 errors");
    expect(input.messages.at(-1)!.content).toBe("I changed a.ts and b.ts.");
  });

  it("a failed step is a failed note", async () => {
    parentSession();
    threadSession();
    const { finished } = await startThread(model("Step 1 failed because the tests don't pass; fix them and press Continue."));
    finish("kid", "s1", { status: "failed", note: "tests fail" });
    await finished;
    expect(thread()).toMatchObject({ status: "failed", report: { text: expect.stringContaining("Step 1 failed") } });
  });

  it("a plan that didn't finish is an unfinished note", async () => {
    parentSession();
    threadSession();
    const { finished } = await startThread(model("It got through the first step."));
    finish("kid", "s1");
    await vi.waitFor(() => expect(fileOf("kid").plan[0].status).toBe("done"));
    // A step that asks the user stops the plan unfinished.
    finish("kid", "s2", { status: "waiting", note: "Which database?" });
    await finished;
    expect(thread().status).toBe("unfinished");
  });

  it("uses a plain sentence from the steps when the request fails", async () => {
    parentSession();
    threadSession();
    const { finished } = await startThread(model(null));
    finish("kid", "s1");
    await vi.waitFor(() => expect(fileOf("kid").plan[0].status).toBe("done"));
    finish("kid", "s2", { status: "failed", note: "The build broke" });
    await finished;
    expect(thread()).toMatchObject({
      status: "failed",
      report: { text: "Step 2 failed. The build broke. Open the thread to see what happened." },
    });
  });

  it("uses the plain sentence when the request throws, and says all done when it is", async () => {
    parentSession();
    threadSession();
    const { finished } = await startThread(vi.fn(async () => Promise.reject(new Error("model is gone"))));
    finish("kid", "s1");
    finish("kid", "s2");
    await finished;
    expect(thread()).toMatchObject({ status: "done", report: { text: "All 2 steps are done." } });
  });

  it("a stopped run is unfinished, with the plain sentence and no request to the model", async () => {
    parentSession();
    threadSession();
    const ask = model("never used");
    const { finished } = await startThread(ask);
    await vi.waitFor(() => expect(hub.liveRun("kid")?.streaming).toBe(true));
    finish("kid", "s1");
    await vi.waitFor(() => expect(fileOf("kid").plan[0].status).toBe("done"));
    await vi.waitFor(() => expect(hub.liveRun("kid")?.streaming).toBe(true));
    await runners.stopRun("kid");
    await finished;
    expect(ask).not.toHaveBeenCalled();
    expect(thread()).toMatchObject({
      status: "unfinished",
      report: { text: "You stopped it after 1 of 2 steps. Continue in the thread to go on." },
    });
  });

  it("a run that ended with an error says so in the plain sentence", async () => {
    parentSession();
    threadSession();
    const { finished } = await startThread(model(null));
    handles.get("kid")!.setError("Couldn't reach C");
    finish("kid", "s1");
    await vi.waitFor(() => expect(fileOf("kid").plan[0].status).toBe("done"));
    // The second step doesn't finish: it goes back to pending and the plan ends.
    finish("kid", "s2", { status: "pending", note: "never ran" });
    await finished;
    expect(thread().status).toBe("unfinished");
    expect(thread().report.text).toBe("It stopped after 1 of 2 steps. Couldn't reach C. Continue in the thread to try again.");
  });

  it("a new run replaces the old report at once, and the new status", async () => {
    parentSession({ threads: [{ ...NOTE, status: "failed", report: { text: "Old report.", at: 1 } }] });
    threadSession({ plan: [{ id: "s1", text: "One", status: "pending" }] });
    const { finished } = await startThread(model("Fresh report."));
    expect(thread().report.text).toBe("Old report."); // while it runs the page shows the spinner instead
    finish("kid", "s1");
    await finished;
    const first = threadEvents(events)[0];
    expect(first).toMatchObject({ status: "done", report: null });
    expect(thread()).toMatchObject({ status: "done", report: { text: "Fresh report." } });
  });

  it("keeps other notes in the parent as they are", async () => {
    const other = { sessionId: "other", summary: "Another", anchor: null, status: "done", report: { text: "Fine.", at: 2 } };
    parentSession({ threads: [other, NOTE] });
    threadSession();
    const { finished } = await startThread(model("Done."));
    finish("kid", "s1");
    finish("kid", "s2");
    await finished;
    const threads = fileOf("p").threads;
    expect(threads[0]).toEqual(other);
    expect(threads[1]).toMatchObject({ sessionId: "kid", status: "done" });
  });

  it("goes through the parent's live session while the parent has a run of its own", async () => {
    parentSession({ plan: [{ id: "q1", text: "Parent step", status: "pending" }], messages: [request] });
    threadSession();
    await runners.startRunner("p", env, {
      run: (cb) => fakeRun("p", cb),
      reply: (h) => {
        handles.set(h.sessionId, h);
        return async (_text, before) => ({ ok: true, messages: before });
      },
      report: model("n/a"),
    });
    const { finished } = await startThread(model("The thread did it."));
    finish("kid", "s1");
    finish("kid", "s2");
    await finished;

    // The run's own copy has it, so the run's next save doesn't undo it.
    expect(handles.get("p")!.getSession().threads![0]).toMatchObject({ status: "done", report: { text: "The thread did it." } });
    expect(thread()).toMatchObject({ status: "done", report: { text: "The thread did it." } });
    expect(hub.liveRun("p")).not.toBeNull();
    finish("p", "q1");
    await settle("p");
    expect(thread()).toMatchObject({ status: "done", report: { text: "The thread did it." } });
  });

  it("leaves a parent alone that has no note for the thread, or that is gone", async () => {
    parentSession({ threads: [] });
    threadSession();
    const ask = model("Nope.");
    const { finished } = await startThread(ask);
    finish("kid", "s1");
    finish("kid", "s2");
    await finished;
    expect(fileOf("p").revision).toBe(5);
    expect(fileOf("p").threads).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
    expect(threadEvents(events)).toEqual([]);

    // A parent that was deleted meanwhile: nothing thrown, nothing written.
    files.delete("p");
    resetFakes();
    threadSession({ plan: [{ id: "s1", text: "One", status: "pending" }] });
    const again = await startThread(ask);
    finish("kid", "s1");
    await expect(again.finished).resolves.toBeUndefined();
    expect(files.has("p")).toBe(false);
  });

  it("a session that is nobody's thread reports to no one", async () => {
    parentSession();
    threadSession({ parentId: null });
    const ask = model("Nope.");
    const { finished } = await startThread(ask);
    finish("kid", "s1");
    finish("kid", "s2");
    await finished;
    expect(ask).not.toHaveBeenCalled();
    expect(fileOf("p").revision).toBe(5);
  });

  it("holds no key in the note, the request or the events", async () => {
    parentSession();
    threadSession();
    const { finished } = await startThread(model("Done."));
    finish("kid", "s1");
    finish("kid", "s2");
    await finished;
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(asked)).not.toContain(SECRET);
    expect(JSON.stringify(fileOf("p"))).not.toContain(SECRET);
    expect(JSON.stringify(env)).not.toContain(SECRET);
  });
});

describe("the wait for the model", () => {
  it("gives up after the time allowed and writes the plain sentence", async () => {
    parentSession();
    vi.useFakeTimers();
    let aborted = false;
    const slow: Ask = (_input, _env, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }),
      );
    const session = { ...makeSession("kid", 1), parentId: "p", messages: [request] } as any;
    session.plan = [{ id: "s1", text: "One", status: "done" }];
    const reporting = reportToParent({ id: "kid", session, env, error: null, stopped: false }, slow);
    await vi.advanceTimersByTimeAsync(REPORT_TIMEOUT_MS - 1);
    expect(aborted).toBe(false);
    expect(thread()).toMatchObject({ status: "done" });
    expect(thread().report).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await reporting;
    expect(aborted).toBe(true);
    expect(thread().report.text).toBe("The one step is done.");
  });
});
