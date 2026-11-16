import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const { NOT_STARTED_CALL, MAY_HAVE_RUN_CALL, SAFE_TO_REPEAT_CALL, UNFINISHED_CALL } = await import("../../src/closeOpenToolCalls.ts");

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

  it("closes a started tool call (no question pending) with the may-have-run text", () => {
    const started = [midStep[0], { ...midStep[1], toolCalls: [{ ...call, started: true }] }];
    const out = markInterrupted({ plan: [step("s2", "running")], messages: started, failed: null }, { status: "running", startedAt: 1 });
    expect(out.messages).toHaveLength(3);
    expect(out.messages[2]).toMatchObject({ role: "tool", toolCallId: "call-1", content: MAY_HAVE_RUN_CALL, planStep: "s2" });
    expect(out.failed).toBe("interrupted");
  });

  it("closes a call that was waiting for approval with the did-not-run text", () => {
    const out = markInterrupted(
      { plan: [step("s2", "running")], messages: midStep, failed: null },
      { status: "waiting", startedAt: 1, ask: waitingRun.ask, marksCalls: true } as any,
    );
    expect(out.messages[2]).toMatchObject({ role: "tool", toolCallId: "call-1", content: NOT_STARTED_CALL, planStep: "s2" });
  });

  it("with two open unmarked calls, both did not run and the model is told to ask again", () => {
    const two = [
      { role: "user", content: "Do it" },
      { role: "assistant", content: "", toolCalls: [call, { id: "call-2", name: "run_command", arguments: "{}" }], planStep: "s2" },
    ];
    const out = markInterrupted(
      { plan: [step("s2", "running")], messages: two, failed: null },
      { status: "waiting", startedAt: 1, ask: waitingRun.ask, marksCalls: true } as any,
    );
    expect(out.messages).toHaveLength(4);
    expect(out.messages[2]).toMatchObject({ toolCallId: "call-1", content: NOT_STARTED_CALL });
    expect(out.messages[3]).toMatchObject({ toolCallId: "call-2", content: NOT_STARTED_CALL });
  });

  it("with the mark: a started command may have run, an unmarked command did not, an unmarked read is safe to repeat", () => {
    const calls = [
      { id: "c-run", name: "run_command", arguments: "{}", started: true },
      { id: "c-no", name: "run_command", arguments: "{}" },
      { id: "c-read", name: "read_file", arguments: "{}" },
    ];
    const out = markInterrupted(
      { plan: [step("s2", "running")], messages: [{ role: "user", content: "Do it" }, { role: "assistant", content: "", toolCalls: calls, planStep: "s2" }], failed: null },
      { status: "running", startedAt: 1, marksCalls: true },
    );
    expect(out.messages.slice(2).map((m: any) => [m.toolCallId, m.content])).toEqual([
      ["c-run", MAY_HAVE_RUN_CALL],
      ["c-no", NOT_STARTED_CALL],
      ["c-read", SAFE_TO_REPEAT_CALL],
    ]);
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

describe("the interrupted note, from the audit log", () => {
  const auditDir = () => path.join(home.dir, ".llama-mui", "audit");
  const today = () => path.join(auditDir(), `audit-${new Date().toISOString().slice(0, 10)}.log`);
  const fsLine = (session: string, p: string, extra: object = {}, at = Date.now()) =>
    JSON.stringify({ t: new Date(at).toISOString(), event: "io.fs", session, path: p, why: "write", ...extra });
  const writeAudit = async (lines: string[]) => {
    await mkdir(auditDir(), { recursive: true });
    await writeFile(today(), lines.join("\n") + "\n");
  };
  const started = { id: "call-1", name: "run_command", arguments: JSON.stringify({ command: "npm test -- --watch=false" }), started: true };
  const inFlight = [
    { role: "user", content: "Do it" },
    { role: "assistant", content: "", toolCalls: [started], planStep: "s1" },
  ];
  const noteOf = async (id: string) => (await get(id)).plan[0].note as string;
  const settle = async (id: string, extra: object = {}) => {
    await put(id, { plan: [step("s1", "running")], messages: inFlight, run: { status: "running", startedAt: Date.now() - 60_000 }, ...extra });
    await recoverInterruptedRuns();
    return noteOf(id);
  };

  beforeEach(async () => {
    await rm(auditDir(), { recursive: true, force: true });
  });

  it("names the call that was running and the files this chat changed, not another chat's", async () => {
    await writeAudit([
      fsLine("n1", "/work/a.ts"),
      fsLine("other", "/work/theirs.ts"),
      fsLine("n1", "/work/failed.ts", { error: "denied" }),
      fsLine("n1", "/work/old.ts", {}, Date.now() - 3_600_000),
      fsLine("n1", "/work/b.ts"),
      "{half a line",
    ]);
    const note = await settle("n1");
    expect(note).toBe("Interrupted by a restart. In progress: run_command (npm test -- --watch=false). Files changed since the run started: /work/a.ts, /work/b.ts.");
    expect(note).not.toContain("theirs");
  });

  it("lists a file changed by an earlier step of the same run under 'since the run started'", async () => {
    await writeAudit([fsLine("n1b", "/work/from-step-1.ts", {}, Date.now() - 30_000)]);
    const earlier = [
      { role: "user", content: "Do it" },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "write_file", arguments: JSON.stringify({ path: "/work/from-step-1.ts" }), started: true }], planStep: "s0" },
      { role: "tool", toolCallId: "c0", content: "done" },
      { role: "assistant", content: "", toolCalls: [started], planStep: "s1" },
    ];
    await settle("n1b", { messages: earlier, plan: [step("s0", "done"), step("s1", "running")] });
    const note = (await get("n1b")).plan[1].note as string;
    expect(note).toContain("Files changed since the run started: /work/from-step-1.ts.");
    expect(note).not.toContain("since the step started");
  });

  it("lists ten files and says how many more", async () => {
    await writeAudit(Array.from({ length: 13 }, (_, i) => fsLine("n2", `/work/f${i}.ts`, {}, Date.now() - 1000 + i)));
    const note = await settle("n2");
    expect(note).toContain("/work/f9.ts, and 3 more.");
    expect(note).not.toContain("/work/f10.ts");
  });

  it("caps a long command and never shows file contents", async () => {
    const big = { ...started, arguments: JSON.stringify({ command: "x".repeat(300) }) };
    const write = { id: "call-2", name: "write_file", arguments: JSON.stringify({ path: "/work/a.ts", content: "SECRET-CONTENT" }), started: true };
    const note = await settle("n3", { messages: [inFlight[0], { role: "assistant", content: "", toolCalls: [big, write], planStep: "s1" }] });
    expect(note.length).toBeLessThan(250);
    expect(note).toContain("write_file (/work/a.ts)");
    expect(note).not.toContain("SECRET-CONTENT");
  });

  it("keeps the plain note when the audit can't be read, or the chat has nothing to report", async () => {
    // A folder where today's file should be: reading it fails.
    await mkdir(today(), { recursive: true });
    expect(await settle("n4", { messages: [{ role: "user", content: "Do it" }] })).toBe(INTERRUPTED_NOTE);
    // The call is still named without the audit.
    expect(await settle("n5")).toBe("Interrupted by a restart. In progress: run_command (npm test -- --watch=false).");
  });
});

describe("a reply that was cut off while streaming", () => {
  const partial = { role: "assistant", content: "Let me start by loo" };
  const run = (extra: object = {}) => ({ status: "running", startedAt: 1, streaming: true, request: "reply", ...extra }) as any;

  it("stays on screen, marked cut off (it is left out of the request, see streamChat)", () => {
    const out = markInterrupted({ plan: [step("s1", "running")], messages: [{ role: "user", content: "Go" }, partial] }, run());
    expect(out.messages).toEqual([{ role: "user", content: "Go" }, { ...partial, cutOff: true }]);
  });

  it("is never marked when the request in flight was a step's check, or the record has no kind", () => {
    const done = [{ role: "user", content: "Go" }, { role: "assistant", content: "All done." }];
    expect(markInterrupted({ plan: null, messages: done }, run({ request: "check" })).messages).toEqual(done);
    expect(markInterrupted({ plan: null, messages: done }, run({ request: undefined })).messages).toEqual(done);
  });

  it("keeps a finished reply when no request was in flight, and one that has calls", () => {
    const done = [{ role: "user", content: "Go" }, partial];
    expect(markInterrupted({ plan: null, messages: done }, { status: "running", startedAt: 1 } as any).messages).toEqual(done);
    const withCall = [{ role: "user", content: "Go" }, { role: "assistant", content: "Running it", toolCalls: [call] }];
    const out = markInterrupted({ plan: null, messages: withCall }, run());
    expect(out.messages[1]).toEqual(withCall[1]);
  });

  it("only the last message is marked: earlier replies are untouched", () => {
    const msgs = [{ role: "user", content: "Go" }, { role: "assistant", content: "First, done." }, { role: "user", content: "More" }, partial];
    expect(markInterrupted({ plan: null, messages: msgs }, run()).messages).toEqual([...msgs.slice(0, 3), { ...partial, cutOff: true }]);
  });
});

describe("the cut-off mark in the saved chat", () => {
  it("is written to the file when a reply was in flight, and not when a check was", async () => {
    const msgs = [{ role: "user", content: "Go" }, { role: "assistant", content: "Half of an ans" }];
    await put("cut-reply", { plan: null, messages: msgs, run: { status: "running", startedAt: 1, streaming: true, request: "reply", marksCalls: true } });
    await put("cut-check", { plan: null, messages: msgs, run: { status: "running", startedAt: 1, streaming: true, request: "check", marksCalls: true } });
    await recoverInterruptedRuns();
    expect((await get("cut-reply")).messages).toEqual([msgs[0], { ...msgs[1], cutOff: true }]);
    expect((await get("cut-check")).messages).toEqual(msgs);
  });
});

describe("an approved call that never got the started mark", () => {
  it("is closed as did-not-run, and a call with a result is left as it was", () => {
    const done = { id: "call-0", name: "write_file", arguments: "{}", started: true };
    const msgs = [
      { role: "user", content: "Go" },
      { role: "assistant", content: "", toolCalls: [done, call], planStep: "s1" },
      { role: "tool", content: "written", toolCallId: "call-0", planStep: "s1" },
    ];
    const out = markInterrupted({ plan: [step("s1", "running")], messages: msgs }, { status: "running", startedAt: 1, marksCalls: true });
    expect(out.messages.slice(0, 3)).toEqual(msgs);
    expect(out.messages).toHaveLength(4);
    expect(out.messages[3]).toMatchObject({ toolCallId: "call-1", content: NOT_STARTED_CALL });
    expect(NOT_STARTED_CALL).toMatch(/approve it again/);
  });

  it("a run record without the flag (an older build) says it may have run, in a chat with no mark", () => {
    const msgs = [
      { role: "user", content: "Go" },
      { role: "assistant", content: "", toolCalls: [call], planStep: "s1" },
    ];
    const session = { plan: [step("s1", "running")], messages: msgs };
    const old = markInterrupted(session, { status: "running", startedAt: 1 });
    expect(old.messages[2]).toMatchObject({ toolCallId: "call-1", content: MAY_HAVE_RUN_CALL });
    const flagged = markInterrupted(session, { status: "running", startedAt: 1, marksCalls: true });
    expect(flagged.messages[2]).toMatchObject({ toolCallId: "call-1", content: NOT_STARTED_CALL });
  });

  it("a record without the flag still trusts a missing mark when the chat already has one", () => {
    const msgs = [
      { role: "user", content: "Go" },
      { role: "assistant", content: "", toolCalls: [{ ...call, id: "c-a", started: true }, call], planStep: "s1" },
    ];
    const out = markInterrupted({ plan: [step("s1", "running")], messages: msgs }, { status: "running", startedAt: 1 });
    expect(out.messages.slice(2).map((m: any) => [m.toolCallId, m.content])).toEqual([
      ["c-a", MAY_HAVE_RUN_CALL],
      ["call-1", UNFINISHED_CALL],
    ]);
  });

  it("a run started now writes the flag into the run record, and keeps it through updates", async () => {
    await put("flag-a", { messages: [] });
    await hub.beginRun("flag-a", { marksCalls: true });
    await hub.updateRun("flag-a", { status: "waiting", streaming: true });
    expect(hub.liveRun("flag-a")).toMatchObject({ marksCalls: true });
    expect((await get("flag-a")).run).toMatchObject({ marksCalls: true });
    await hub.endRun("flag-a");
  });
});

describe("markInterrupted and the queue", () => {
  const queued = [{ id: "q1", text: "next", options: { model: "m", toolsOn: false, modelOptions: {} }, queuedAt: 1 }];

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
    const queue = [{ id: "q1", text: "next", options: { model: "m", toolsOn: false, modelOptions: {} }, queuedAt: 1 }];
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
