import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui. The session
// files are real files in it.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const hub = await import("../runHub.ts");
const { INTERRUPTED_NOTE, markInterrupted, recoverInterruptedRuns } = await import("../restart.ts");
const { UNFINISHED_CALL } = await import("../../src/closeOpenToolCalls.ts");

const file = (id: string) => path.join(home.dir, ".llama-mui", "sessions", id, "session.json");
const put = async (id: string, session: object) => {
  await mkdir(path.dirname(file(id)), { recursive: true });
  await writeFile(file(id), JSON.stringify({ id, title: id, updatedAt: 1, ...session }));
};
const get = async (id: string) => JSON.parse(await readFile(file(id), "utf8"));

const step = (id: string, status: string, extra: object = {}) => ({ id, text: `Step ${id}`, status, ...extra });
const call = { id: "call-1", name: "run_command", arguments: "{}" };
const midStep = [
  { role: "user", content: "Do it" },
  { role: "assistant", content: "", toolCalls: [call], planStep: "s2" },
];
const waitingRun = {
  status: "waiting",
  startedAt: 5,
  streaming: true,
  ask: { id: "ask-1", kind: "approval", details: { name: "run_command" } },
};

let events: any[] = [];
let unsubscribe = () => {};
beforeEach(() => {
  events = [];
  unsubscribe = hub.subscribe((e) => events.push(e));
});
afterEach(() => unsubscribe());

describe("markInterrupted", () => {
  it("puts a running step back to pending with a note, and leaves the others alone", () => {
    const session = { plan: [step("s1", "done"), step("s2", "running"), step("s3", "pending")], messages: [], failed: null };
    const out = markInterrupted(session, { status: "running", startedAt: 1 });
    expect(out.plan).toEqual([step("s1", "done"), step("s2", "pending", { note: INTERRUPTED_NOTE }), step("s3", "pending")]);
    // The input is not changed.
    expect(session.plan[1].status).toBe("running");
  });

  it("keeps an answer the user gave a step, and its summary", () => {
    const out = markInterrupted(
      { plan: [step("s1", "running", { summary: "Short", answer: "Postgres", asked: "Which database?" })], messages: [] },
      { status: "running", startedAt: 1 },
    );
    expect(out.plan[0]).toEqual({
      id: "s1",
      text: "Step s1",
      summary: "Short",
      status: "pending",
      note: INTERRUPTED_NOTE,
      answer: "Postgres",
      asked: "Which database?",
    });
  });

  it("closes a tool call that never got a result, and says the reply was cut off", () => {
    const out = markInterrupted({ plan: [step("s2", "running")], messages: midStep, failed: null }, { status: "running", startedAt: 1 });
    expect(out.messages).toHaveLength(3);
    expect(out.messages[2]).toMatchObject({ role: "tool", toolCallId: "call-1", content: UNFINISHED_CALL, planStep: "s2" });
    expect(out.failed).toBe("interrupted");
  });

  it("puts a message no step had seen into the chat, marked as not seen", () => {
    const out = markInterrupted(
      { plan: [step("s1", "pending")], messages: [{ role: "user", content: "Go" }] },
      { status: "waiting", startedAt: 1, notes: [{ id: "n1", text: "Use tabs", step: 1, stepId: "s1" }] },
    );
    expect(out.messages.at(-1)).toEqual({ role: "user", content: "Use tabs", notSeen: true });
    // Nothing was in flight, so the earlier failure state stays as it was.
    expect(out.failed).toBeNull();
  });

  it("a run that was one chat reply is cut off too, and its plan is not touched", () => {
    const plan = [step("s1", "pending")];
    const out = markInterrupted({ plan, messages: [], failed: null }, { status: "running", startedAt: 1, kind: "turn" });
    expect(out.failed).toBe("interrupted");
    expect(out.plan).toEqual(plan);
  });

  it("copes with a session that has no plan and no messages", () => {
    expect(markInterrupted({}, { status: "running", startedAt: 1, kind: "turn" })).toMatchObject({ plan: null, messages: [] });
  });
});

describe("markInterrupted and the queue", () => {
  const queued = [{ id: "q1", text: "next", options: { model: "m", toolsOn: false, thinkOn: false }, queuedAt: 1 }];

  it("keeps the queue and pauses it", () => {
    const out = markInterrupted({ messages: [], queue: queued }, { status: "running", startedAt: 1, kind: "turn" });
    expect(out.queue).toEqual(queued);
    expect(out.queuePaused).toBe(true);
  });

  it("adds no pause to a session with an empty queue or none", () => {
    expect(markInterrupted({ messages: [], queue: [] }, { status: "running", startedAt: 1, kind: "turn" })).not.toHaveProperty("queuePaused");
    expect(markInterrupted({ messages: [] }, { status: "running", startedAt: 1, kind: "turn" })).not.toHaveProperty("queuePaused");
  });
});

describe("recoverInterruptedRuns", () => {
  it("leaves a waiting queue paused, after a run that was cut off and with no run record", async () => {
    const queue = [{ id: "q1", text: "next", options: { model: "m", toolsOn: false, thinkOn: false }, queuedAt: 1 }];
    await put("cut", { plan: null, messages: [], revision: 3, run: { status: "running", startedAt: 1, kind: "turn", streaming: true }, queue });
    await put("idle", { plan: null, messages: [], revision: 3, queue });
    await put("done", { plan: null, messages: [], revision: 3, queue: [], queuePaused: false });
    const doneBefore = await readFile(file("done"), "utf8");
    await recoverInterruptedRuns();
    const cut = await get("cut");
    expect(cut).toMatchObject({ queue, queuePaused: true });
    expect(cut.run).toBeUndefined();
    expect(await get("idle")).toMatchObject({ queue, queuePaused: true, revision: 4 });
    // An empty queue, and one already paused, are not written again.
    expect(await readFile(file("done"), "utf8")).toBe(doneBefore);
    await recoverInterruptedRuns();
    expect((await get("idle")).revision).toBe(4);
  });

  it("settles a session whose saved run was active, and removes the record", async () => {
    await put("a", {
      plan: [step("s1", "done"), step("s2", "running"), step("s3", "pending")],
      messages: midStep,
      revision: 4,
      run: waitingRun,
    });
    expect(await recoverInterruptedRuns()).toEqual(["a"]);

    const after = await get("a");
    expect(after.run).toBeUndefined(); // the question went with it: nothing can answer it now
    expect(JSON.stringify(after)).not.toContain("ask-1");
    expect(after.revision).toBe(5);
    expect(after.plan.map((s: any) => s.status)).toEqual(["done", "pending", "pending"]);
    expect(after.plan[1].note).toBe("Interrupted by a restart");
    expect(after.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(after.failed).toBe("interrupted");
    // Pages that are connected hear that it was saved.
    expect(events.filter((e) => e.id === "a").map((e) => [e.type, e.data.revision])).toEqual([["saved", 5]]);
  });

  it("does not start anything again, and a second look finds nothing to do", async () => {
    await put("b", { plan: [step("s1", "running")], messages: [], run: { status: "running", startedAt: 1 } });
    await recoverInterruptedRuns();
    expect(hub.liveRun("b")).toBeNull();
    expect(hub.liveRuns().map((r) => r.id)).not.toContain("b");
    const before = await readFile(file("b"), "utf8");
    expect(await recoverInterruptedRuns()).not.toContain("b");
    expect(await readFile(file("b"), "utf8")).toBe(before);
  });

  it("leaves a session with no run record exactly as it is", async () => {
    await put("quiet", { plan: [step("s1", "running")], messages: midStep, revision: 2 });
    const before = await readFile(file("quiet"), "utf8");
    expect(await recoverInterruptedRuns()).not.toContain("quiet");
    expect(await readFile(file("quiet"), "utf8")).toBe(before);
  });

  it("the page can save the settled session at once, with the revision it loaded", async () => {
    await put("c", { plan: [step("s1", "running")], messages: [], revision: 7, run: { status: "running", startedAt: 1 } });
    await recoverInterruptedRuns();
    const loaded = await get("c");
    const saved = await hub.replace("c", (old) => ({ ...old, title: "Edited" }), loaded.revision);
    expect(saved.revision).toBe(9);
    expect((await get("c")).title).toBe("Edited");
  });

  it("tells a thread's parent that the thread did not finish", async () => {
    const note = { sessionId: "kid", summary: "Do two things", anchor: "call-1", planId: "plan-1", status: "done" as const, report: { text: "Old.", at: 1 } };
    await put("p", { plan: null, messages: [], threads: [note], revision: 3 });
    await put("kid", {
      parentId: "p",
      planId: "plan-1",
      plan: [step("s1", "done"), step("s2", "running")],
      messages: [{ role: "user", content: "THREAD-TEXT" }],
      run: { status: "running", startedAt: 1 },
    });
    await recoverInterruptedRuns();

    const parent = await get("p");
    expect(parent.revision).toBe(4);
    expect(parent.threads).toHaveLength(1);
    expect(parent.threads[0]).toMatchObject({ sessionId: "kid", planId: "plan-1", status: "unfinished" });
    expect(parent.threads[0].report.text).toBe(
      "The server restarted while this was running, so it stopped after 1 of 2 steps. Open the thread and press Continue to go on.",
    );
    // Only the status and the sentence reach the parent, never the thread's messages.
    expect(JSON.stringify(parent)).not.toContain("THREAD-TEXT");
    expect(events.filter((e) => e.type === "thread")).toEqual([
      { type: "thread", id: "p", data: { sessionId: "kid", planId: "plan-1", status: "unfinished", report: parent.threads[0].report, revision: 4 } },
    ]);
  });

  it("leaves a parent alone when the run was a chat reply, has no note for it, or is gone", async () => {
    await put("p2", { plan: null, messages: [], threads: [{ sessionId: "kid2", summary: "x", anchor: null, status: "done" }], revision: 1 });
    await put("kid2", { parentId: "p2", plan: null, messages: [], run: { status: "running", startedAt: 1, kind: "turn" } });
    await put("p3", { plan: null, messages: [], threads: [], revision: 1 });
    await put("kid3", { parentId: "p3", plan: [step("s1", "running")], messages: [], run: { status: "running", startedAt: 1 } });
    await put("kid4", { parentId: "deleted-parent", plan: [step("s1", "running")], messages: [], run: { status: "running", startedAt: 1 } });
    const ids = await recoverInterruptedRuns();

    expect(ids).toEqual(expect.arrayContaining(["kid2", "kid3", "kid4"]));
    expect((await get("p2")).revision).toBe(1);
    expect((await get("p2")).threads[0].status).toBe("done");
    expect((await get("p3")).revision).toBe(1);
    expect((await get("kid4")).plan[0].status).toBe("pending");
  });

  it("a session with a run in this process is not stale and is left alone", async () => {
    await put("live", { plan: [step("s1", "running")], messages: [], revision: 1, run: { status: "running", startedAt: 1 } });
    const session = { ...(await get("live")), plan: [step("s1", "running")] };
    await hub.beginRun("live", { session: () => session });
    try {
      expect(await recoverInterruptedRuns()).not.toContain("live");
      expect(hub.liveRun("live")).toMatchObject({ status: "running" });
      expect(session.plan[0].status).toBe("running");
    } finally {
      await hub.endRun("live");
    }
  });
});
