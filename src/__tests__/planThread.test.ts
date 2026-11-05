import { describe, expect, it } from "vitest";
import type { Attachment, ChatMessage, PlanStep, PlanThread, Session } from "../api";
import { applyThreadEvent, isFreshPlan, noteView, planRequestFor, planToThread, threadLabel, threadStatus, threadsUpdate, planResult, finalMessage, noteAskKind, worktreeLine, worktreeLines } from "../planThread";

const step = (id: string, status: PlanStep["status"] = "pending", extra: Partial<PlanStep> = {}): PlanStep => ({
  id,
  text: `Do ${id} in detail`,
  summary: `Step ${id}`,
  status,
  ...extra,
});

// A chat where the user asked twice; the plan was written after the second ask
// (by the update_plan call "call-1"), and the user wrote once more after it.
const chat = (): ChatMessage[] => [
  { role: "user", content: "an old question" },
  { role: "assistant", content: "an old answer" },
  { role: "user", content: "Build the thing" },
  {
    role: "assistant",
    content: "Here is a plan.",
    toolCalls: [{ id: "call-1", name: "update_plan", arguments: "{}" }],
  },
  { role: "tool", content: "ok", toolCallId: "call-1" },
  { role: "user", content: "and something after the plan" },
];

const folder: Attachment = { path: "/work/app", kind: "folder", source: "manual" };

const parentSession = (extra: Partial<Session> = {}): Session => ({
  id: "parent",
  title: "Build the thing",
  model: "model-a",
  messages: chat(),
  contextStart: 0,
  attachments: [folder],
  usage: null,
  failed: null,
  plan: [step("1"), step("2")],
  planContext: "Use TypeScript.",
  planSummary: "Build the thing in two steps",
  planAnchor: "call-1",
  ...extra,
});

describe("planToThread: the child", () => {
  it("starts from the request before the plan, not the whole history", () => {
    const { child } = planToThread(parentSession(), "child")!;
    expect(child.messages).toEqual([{ role: "user", content: "Build the thing" }]);
    expect(child.messages.some((m) => m.planStep)).toBe(false);
  });

  it("holds the plan, its context and summary, anchored after the first message", () => {
    const { child } = planToThread(parentSession(), "child")!;
    expect(child.plan).toEqual([step("1"), step("2")]);
    expect(child.planContext).toBe("Use TypeScript.");
    expect(child.planSummary).toBe("Build the thing in two steps");
    expect(child.planAnchor).toBe("at:1");
    expect(child.planMovedIn).toBe(true);
  });

  it("is nested under the parent and inherits its model and folders", () => {
    const { child } = planToThread(parentSession(), "child")!;
    expect(child.id).toBe("child");
    expect(child.parentId).toBe("parent");
    expect(child.model).toBe("model-a");
    expect(child.attachments).toEqual([folder]);
  });

  it("copies the attachments and steps instead of sharing them", () => {
    const parent = parentSession();
    const { child } = planToThread(parent, "child")!;
    expect(child.attachments[0]).not.toBe(parent.attachments[0]);
    expect(child.plan![0]).not.toBe(parent.plan![0]);
    child.attachments[0].path = "/elsewhere";
    child.plan![0].status = "done";
    expect(parent.attachments[0].path).toBe("/work/app");
    expect(parent.plan![0].status).toBe("pending");
  });

  it("has no history, usage, failure or todos of the parent's", () => {
    const { child } = planToThread(parentSession({ usage: { contextTokens: 5 }, failed: "boom" }), "child")!;
    expect(child.usage).toBeNull();
    expect(child.failed).toBeNull();
    expect(child.contextStart).toBe(0);
    expect(child.pastPlans).toEqual([]);
  });

  it("is titled from the plan summary", () => {
    const { child } = planToThread(parentSession(), "child")!;
    expect(child.title).toBe("Build the thing in two steps");
    expect(child.titleHint).toBe("Build the thing in two steps");
  });

  it("is titled from the first step when the plan has no summary", () => {
    const { child } = planToThread(parentSession({ planSummary: null }), "child")!;
    expect(child.title).toBe("Step 1");
    expect(child.titleHint).toBe("Step 1");
    expect(child.planSummary).toBeNull();
  });

  it("cuts a long title to 80 characters", () => {
    const { child } = planToThread(parentSession({ planSummary: "x".repeat(200) }), "child")!;
    expect(child.title).toBe("x".repeat(80));
    expect(child.titleHint).toBe("x".repeat(80));
  });

  it("follows an 'at:N' anchor to the request before that point", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
      { role: "assistant", content: "ok" },
    ];
    const { child } = planToThread(parentSession({ messages, planAnchor: "at:2" }), "child")!;
    expect(child.messages).toEqual([{ role: "user", content: "first" }]);
  });

  it("falls back to the summary, then to a plain line, when there is no request", () => {
    const none = parentSession({ messages: [], planAnchor: "at:0" });
    expect(planToThread(none, "child")!.child.messages[0].content).toBe("Build the thing in two steps");
    const bare = parentSession({ messages: [], planAnchor: "at:0", planSummary: null });
    expect(planToThread(bare, "child")!.child.messages[0].content).toBe("Run the plan below.");
  });
});

describe("planToThread: the parent", () => {
  it("loses the plan and keeps a note where it was", () => {
    const { parent } = planToThread(parentSession({ planProposal: [step("9")] }), "child", "plan-1")!;
    expect(parent.plan).toBeNull();
    expect(parent.planProposal).toBeNull();
    expect(parent.planContext).toBeNull();
    expect(parent.planSummary).toBeNull();
    expect(parent.planAnchor).toBeNull();
    expect(parent.threads).toEqual([
      { sessionId: "child", summary: "Build the thing in two steps", anchor: "call-1", planId: "plan-1" },
    ]);
  });

  it("names the plan, in the thread and on the note, so the note can point at it", () => {
    const { parent, child } = planToThread(parentSession(), "child", "plan-1")!;
    expect(child.planId).toBe("plan-1");
    expect(parent.threads![0].planId).toBe("plan-1");
    // The session no longer has the plan, so no id for it.
    expect(parent.planId).toBeNull();
  });

  it("makes up an id when none is given, and keeps one the plan already had", () => {
    const made = planToThread(parentSession(), "child")!;
    expect(made.child.planId).toEqual(expect.any(String));
    expect(made.parent.threads![0].planId).toBe(made.child.planId);
    const kept = planToThread(parentSession({ planId: "mine" }), "child")!;
    expect(kept.child.planId).toBe("mine");
    expect(kept.parent.threads![0].planId).toBe("mine");
  });

  it("keeps everything else, and adds to earlier notes", () => {
    const earlier = { sessionId: "old", summary: "Earlier plan", anchor: "call-0" };
    const input = parentSession({ threads: [earlier] });
    const { parent } = planToThread(input, "child")!;
    expect(parent.id).toBe("parent");
    expect(parent.messages).toEqual(chat());
    expect(parent.model).toBe("model-a");
    expect(parent.threads!.map((t) => t.sessionId)).toEqual(["old", "child"]);
  });

  it("uses the first step for the note when the plan has no summary", () => {
    const { parent } = planToThread(parentSession({ planSummary: null }), "child")!;
    expect(parent.threads![0].summary).toBe("Step 1");
  });

  it("does not change the session it was given", () => {
    const input = parentSession();
    const before = structuredClone(input);
    planToThread(input, "child");
    expect(input).toEqual(before);
  });

  it("makes the child under a nested parent, that parent's own child", () => {
    const nested = parentSession({ id: "mid", parentId: "root" });
    const { parent, child } = planToThread(nested, "child")!;
    expect(child.parentId).toBe("mid");
    expect(parent.parentId).toBe("root");
  });
});

describe("planToThread: only a fresh plan moves", () => {
  it("moves a plan whose steps are all pending", () => {
    expect(planToThread(parentSession(), "child")).not.toBeNull();
    expect(isFreshPlan([step("1")], chat())).toBe(true);
  });

  it.each(["done", "failed", "running", "disputed", "waiting"] as const)("keeps a plan with a %s step", (status) => {
    const parent = parentSession({ plan: [step("1", status), step("2")] });
    expect(planToThread(parent, "child")).toBeNull();
  });

  it("keeps a pending plan whose steps already have messages", () => {
    const messages: ChatMessage[] = [...chat(), { role: "user", content: "Do step 1", planStep: "1" }];
    expect(planToThread(parentSession({ messages }), "child")).toBeNull();
  });

  it("keeps a session with no plan or with no steps", () => {
    expect(planToThread(parentSession({ plan: null }), "child")).toBeNull();
    expect(planToThread(parentSession({ plan: [] }), "child")).toBeNull();
  });
});

describe("threadStatus", () => {
  it("is missing when the child can't be found", () => {
    expect(threadStatus(null)).toBe("missing");
  });

  it("is done when every step is done", () => {
    expect(threadStatus({ plan: [step("1", "done"), step("2", "done")] })).toBe("done");
  });

  it("is failed when a step failed or is disputed", () => {
    expect(threadStatus({ plan: [step("1", "done"), step("2", "failed")] })).toBe("failed");
    expect(threadStatus({ plan: [step("1", "disputed"), step("2", "pending")] })).toBe("failed");
  });

  it("is failed even when other steps are still pending", () => {
    expect(threadStatus({ plan: [step("1", "failed"), step("2", "pending")] })).toBe("failed");
  });

  it.each(["pending", "running", "waiting"] as const)("is unfinished with a %s step", (status) => {
    expect(threadStatus({ plan: [step("1", "done"), step("2", status)] })).toBe("unfinished");
  });

  it("is unfinished when the child has no plan or no steps", () => {
    expect(threadStatus({ plan: null })).toBe("unfinished");
    expect(threadStatus({ plan: [] })).toBe("unfinished");
  });
});

describe("threadLabel", () => {
  it("says each status in plain words", () => {
    expect(threadLabel("done", "Build it")).toBe("Done in a thread: Build it");
    expect(threadLabel("failed", "Build it")).toBe("Failed in a thread: Build it");
    expect(threadLabel("unfinished", "Build it")).toBe("Not finished in a thread: Build it");
    expect(threadLabel("missing", "Build it")).toBe("Thread was deleted: Build it");
  });

  it("says running while the status is not known yet", () => {
    expect(threadLabel(undefined, "Build it")).toBe("Running in a thread: Build it");
  });
});

describe("noteView", () => {
  const note: PlanThread = { sessionId: "kid", summary: "Build it", anchor: null };
  const reported: PlanThread = { ...note, status: "failed", report: { text: "Step 2 failed. Open the thread.", at: 5 } };

  it("spins while the thread has a run, whatever the last run left", () => {
    expect(noteView(reported, "running")).toEqual({ running: true, status: undefined });
  });

  it("shows the note's own outcome and report once the run has ended", () => {
    expect(noteView(reported, undefined)).toEqual({ running: false, status: "failed", report: "Step 2 failed. Open the thread." });
    expect(noteView({ ...note, status: "done" }, "unfinished")).toEqual({ running: false, status: "done" });
  });

  it("says a deleted thread is deleted", () => {
    expect(noteView(reported, "missing")).toEqual({ running: false, status: "missing" });
  });

  it("falls back to the thread's saved state for a note without a status", () => {
    expect(noteView(note, "done")).toEqual({ running: false, status: "done" });
    expect(noteView(note, undefined)).toEqual({ running: false, status: undefined });
  });
});

describe("applyThreadEvent", () => {
  const notes: PlanThread[] = [
    { sessionId: "kid", summary: "A", anchor: null, planId: "p1", status: "failed", report: { text: "Old.", at: 1 } },
    { sessionId: "other", summary: "B", anchor: null },
  ];

  it("sets the status and report of the note for that thread, and nothing else", () => {
    const next = applyThreadEvent(notes, { sessionId: "kid", planId: "p1", status: "done", report: { text: "Fine.", at: 9 } });
    expect(next[0]).toEqual({ sessionId: "kid", summary: "A", anchor: null, planId: "p1", status: "done", report: { text: "Fine.", at: 9 } });
    expect(next[1]).toBe(notes[1]);
  });

  it("drops the old report when the event has none yet", () => {
    const next = applyThreadEvent(notes, { sessionId: "kid", status: "unfinished", report: null });
    expect(next[0]).toEqual({ sessionId: "kid", summary: "A", anchor: null, planId: "p1", status: "unfinished" });
  });

  it("changes nothing for a thread or plan it has no note for", () => {
    expect(applyThreadEvent(notes, { sessionId: "nope", status: "done", report: null })).toBe(notes);
    expect(applyThreadEvent(notes, { sessionId: "kid", planId: "p2", status: "done", report: null })).toBe(notes);
  });
});

describe("planRequestFor", () => {
  it("finds the last request before the update_plan call with that id", () => {
    expect(planRequestFor(chat(), "call-1")).toBe("Build the thing");
  });

  it("finds the last request before 'at:N'", () => {
    expect(planRequestFor(chat(), "at:2")).toBe("an old question");
    expect(planRequestFor(chat(), "at:3")).toBe("Build the thing");
  });

  it("skips messages that belong to a plan step", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "the real request" },
      { role: "user", content: "Do step 1", planStep: "1" },
      { role: "assistant", content: "done" },
    ];
    expect(planRequestFor(messages, "at:3")).toBe("the real request");
  });

  it("gives undefined when no user message comes before the plan", () => {
    expect(planRequestFor([], "at:0")).toBeUndefined();
    expect(planRequestFor(chat(), "at:1")).toBe("an old question");
    expect(planRequestFor(chat(), "at:0")).toBeUndefined();
    const onlySteps: ChatMessage[] = [{ role: "user", content: "Do step 1", planStep: "1" }];
    expect(planRequestFor(onlySteps, "at:1")).toBeUndefined();
  });

  it("looks at the whole chat when the anchor matches nothing", () => {
    expect(planRequestFor(chat(), "nope")).toBe("and something after the plan");
    expect(planRequestFor(chat(), null)).toBe("and something after the plan");
  });
});

describe("threadsUpdate", () => {
  const note = (extra: Partial<PlanThread>): PlanThread => ({ sessionId: "c", summary: "Move the runners", anchor: null, ...extra });

  it("says nothing while no thread has an outcome", () => {
    expect(threadsUpdate(undefined)).toBe("");
    expect(threadsUpdate([])).toBe("");
    expect(threadsUpdate([note({})])).toBe("");
  });

  it("lists each ended thread with its outcome and report", () => {
    const text = threadsUpdate([
      note({ status: "done", report: { text: "All three steps passed.\nBranch llama/runners.", at: 1 } }),
      note({ sessionId: "d", summary: "Rename the tool", status: "failed" }),
      note({ sessionId: "e", summary: "Still going" }),
    ]);
    expect(text).toBe(
      [
        "Plans that ran in their own sessions (threads), and how they ended:",
        "- done: Move the runners",
        "  Report: All three steps passed. Branch llama/runners.",
        "- failed: Rename the tool",
      ].join("\n"),
    );
  });
});

describe("finalMessage and planResult", () => {
  const msgs: ChatMessage[] = [
    { role: "assistant", content: "step 1 done", planStep: "1" },
    { role: "assistant", content: "All done.\nFollow-up: restart the server.", planStep: "2" },
    { role: "assistant", content: "   ", planStep: "2" },
    { role: "user", content: "and now something else" },
    { role: "assistant", content: "a later chat reply" },
  ];

  it("finalMessage is the last assistant message with text, whole", () => {
    expect(finalMessage(msgs)).toBe("a later chat reply");
    expect(finalMessage(msgs.slice(0, 3))).toBe("All done.\nFollow-up: restart the server.");
    expect(finalMessage([])).toBe("");
    expect(finalMessage(undefined)).toBe("");
  });

  it("planResult is the last step's last words, once the plan is done", () => {
    const done = [step("1", "done"), step("2", "done")];
    expect(planResult(done, msgs)).toBe("All done.\nFollow-up: restart the server.");
    expect(planResult([step("1", "done"), step("2", "pending")], msgs)).toBe("");
    expect(planResult(null, msgs)).toBe("");
    expect(planResult(done, [{ role: "assistant", content: "x", planStep: "1" }])).toBe("");
  });
});

describe("noteAskKind", () => {
  it("lets the note carry an approval of a command or a change, and allowing a folder", () => {
    expect(noteAskKind({ needsApproval: { type: "command", command: "git status", cwd: "/w" } } as any)).toBe("answer");
    expect(noteAskKind({ needsAccess: { path: "/other", kind: "folder" } })).toBe("answer");
    expect(noteAskKind({ needsAccess: { path: "/other/a.txt", kind: "file" } })).toBe("answer");
  });

  it("sends the user to the thread for a path that doesn't exist, or a file or folder to find", () => {
    expect(noteAskKind({ needsAccess: { path: "/guess", kind: null } })).toBe("open");
    expect(noteAskKind({ needsLocation: { description: "my notes", kind: "folder" } })).toBe("open");
  });
});

describe("worktreeLine", () => {
  const w = { name: "ui-updates", branch: "llama/ui-updates", uncommitted: 0, unmerged: 0, base: "main" };
  it("says what is left", () => {
    expect(worktreeLine({ ...w, uncommitted: 5, unmerged: 2 })).toBe(
      "In worktree ui-updates (llama/ui-updates): 5 files uncommitted, 2 commits not on main",
    );
  });
  it("says all committed and on main when nothing is left", () => {
    expect(worktreeLine(w)).toBe("In worktree ui-updates (llama/ui-updates): all committed and on main");
  });
  it("uses singular and names the base branch", () => {
    expect(worktreeLine({ ...w, uncommitted: 1, base: "develop" })).toBe("In worktree ui-updates (llama/ui-updates): 1 file uncommitted");
    expect(worktreeLine({ ...w, unmerged: 1, base: "develop" })).toBe("In worktree ui-updates (llama/ui-updates): 1 commit not on develop");
  });
  it("copes with an unknown base and a detached HEAD", () => {
    expect(worktreeLine({ ...w, unmerged: null, base: null, branch: null })).toBe("In worktree ui-updates (detached HEAD): all committed");
  });
  it("shows nothing without worktrees", () => {
    expect(worktreeLines([])).toEqual([]);
    expect(worktreeLines(undefined)).toEqual([]);
  });
});
