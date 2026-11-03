import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ChatMessage, type PlanStep } from "../../api";

// vi.hoisted runs in the hoisted scope (same scope as vi.mock), so the
// variable is available when the mock factory is evaluated.
const { mockStreamChat } = vi.hoisted(() => ({
  mockStreamChat: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, streamChat: mockStreamChat };
});

import { runPlan, MAX_RECOVERY_ROUNDS, type RunPlanCallbacks } from "../agent";

// No real model: the check (checkStep → reviewStep → streamChat) answers from
// a script, one answer per check, and so does every reply of a step.

// The check's answers in order: "DONE" or "MISSING: ...". An empty script
// would mean a check nobody expected, so it fails the test.
function scriptChecks(answers: string[]) {
  const queue = [...answers];
  mockStreamChat.mockImplementation(async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("an unexpected check");
    onDelta({ content: next });
    return { toolCalls: [] };
  });
}

interface Turn {
  text: string;
  // A command the turn ran, and what it printed. With tool "read_file", `run`
  // is the path and `printed` the file.
  command?: { run: string; printed: string; tool?: "run_command" | "read_file" };
  ok?: boolean;
  error?: string;
}

// A reply that plays the turns in order, appending the way chat does: the
// prompt, then the model's tool call and result and its text.
function scriptReplies(turns: Turn[]) {
  let n = 0;
  return vi.fn(async (prompt: string, before: ChatMessage[], opts?: { planStep?: string }) => {
    const turn = turns[n];
    if (!turn) throw new Error("an unexpected reply");
    const id = `call${n++}`;
    const planStep = opts?.planStep;
    const added: ChatMessage[] = [{ role: "user", content: prompt, planStep }];
    if (turn.command) {
      added.push({
        role: "assistant",
        content: "",
        toolCalls: [
          turn.command.tool === "read_file"
            ? { id, name: "read_file", arguments: JSON.stringify({ path: turn.command.run }) }
            : { id, name: "run_command", arguments: JSON.stringify({ command: turn.command.run }) },
        ],
        planStep,
      });
      added.push({ role: "tool", toolCallId: id, content: turn.command.printed, planStep });
    }
    added.push({ role: "assistant", content: turn.text, planStep });
    return { ok: turn.ok !== false, messages: [...before, ...added], error: turn.error };
  });
}

function setup(steps: PlanStep[], reply: RunPlanCallbacks["reply"], overrides?: Partial<RunPlanCallbacks>) {
  const planRef = { current: steps as PlanStep[] | null };
  // Like Chat's: a patch replaces everything but the step's id and text.
  const setStep = vi.fn((id: string, patch: Omit<PlanStep, "id" | "text">) => {
    planRef.current = planRef.current!.map((s) => (s.id === id ? { id: s.id, text: s.text, ...patch } : s));
  });
  const cb: RunPlanCallbacks = {
    connector: { id: "test-connector" } as any,
    model: "test-model",
    abort: null,
    planRunningRef: { current: false },
    setPlanRunning: vi.fn(),
    messages: [],
    planRef,
    setStep,
    reply,
    setError: vi.fn(),
    setAbort: vi.fn(),
    modelLoaded: vi.fn().mockResolvedValue(true),
    models: [{ id: "test-model" }] as any[],
    attachments: [],
    checkCommands: {},
    attachedPaths: () => [],
    sessionId: "test-session",
    thinkOn: false,
    toolDefinitions: [],
    ...overrides,
  };
  return { cb, planRef, setStep };
}

const twoSteps = (): PlanStep[] => [
  { id: "s1", text: "Merge llama/x into main", status: "pending" },
  { id: "s2", text: "Delete the branch", status: "pending" },
];
const statuses = (planRef: { current: PlanStep[] | null }) => planRef.current!.map((s) => s.status);
const blocked = { run: "git merge --ff-only llama/x", printed: "error: Your local changes would be overwritten by merge" };

beforeEach(() => {
  mockStreamChat.mockReset();
});

describe("runPlan recovery rounds", () => {
  it("allows two rounds", () => {
    expect(MAX_RECOVERY_ROUNDS).toBe(2);
  });

  it("recovers in round 1 and the plan continues", async () => {
    // Step 1: its turn, the dispute retry, one recovery round. Then step 2.
    const reply = scriptReplies([
      { text: "Merged.", command: blocked },
      { text: "I think it is fine." },
      { text: "I stashed your edit and merged.", command: { run: "git stash && git merge --ff-only llama/x", printed: "Fast-forward" } },
      { text: "Deleted." },
    ]);
    scriptChecks(["MISSING: main wasn't updated", "MISSING: main wasn't updated", "DONE", "DONE"]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["done", "done"]);
    expect(reply).toHaveBeenCalledTimes(4);
    // The round gets the check's words and what the step's commands printed.
    const prompt = reply.mock.calls[2][0];
    expect(prompt).toContain("Step 1 is blocked");
    expect(prompt).toContain("main wasn't updated");
    expect(prompt).toContain("$ run_command git merge --ff-only llama/x");
    expect(prompt).toContain("would be overwritten");
    // It's the same step's turn: its id, and the history from its start.
    expect(reply.mock.calls[2][2]).toMatchObject({ planStep: "s1", from: 0 });
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("fails the step with a short note after two rounds and stops the loop", async () => {
    const long = "the branch still isn't merged because main has local edits ".repeat(8).trim();
    const reply = scriptReplies([
      { text: "Merged.", command: blocked },
      { text: "I think it is fine." },
      { text: "Tried again." },
      { text: "Tried once more." },
    ]);
    // After the step, the dispute retry and each of the two rounds.
    scriptChecks([`MISSING: ${long}`, `MISSING: ${long}`, `MISSING: ${long}`, `MISSING: ${long}`]);
    const { cb, planRef, setStep } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["failed", "pending"]);
    expect(reply).toHaveBeenCalledTimes(2 + MAX_RECOVERY_ROUNDS);
    expect(mockStreamChat).toHaveBeenCalledTimes(2 + MAX_RECOVERY_ROUNDS);
    const note = planRef.current![0].note!;
    expect(long.length).toBeGreaterThan(300);
    expect(note.length).toBeLessThanOrEqual(160);
    expect(note.startsWith("the branch still isn't merged")).toBe(true);
    // The second step never started.
    expect(setStep.mock.calls.some(([id]) => id === "s2")).toBe(false);
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("shows only the end of long output to a round", async () => {
    const printed = "OLDEST-LINE\n" + "x".repeat(5000) + "\nNEWEST-LINE";
    const reply = scriptReplies([
      { text: "Done.", command: { run: "make", printed } },
      { text: "Fine." },
      { text: "QUESTION: retry?" },
    ]);
    scriptChecks(["MISSING: build failed", "MISSING: build failed"]);
    const { cb } = setup(twoSteps(), reply);
    await runPlan(cb);
    const prompt = reply.mock.calls[2][0];
    expect(prompt).toContain("NEWEST-LINE");
    expect(prompt).not.toContain("OLDEST-LINE");
    expect(prompt).toContain("(earlier output cut)");
  });

  it("sets the step to waiting on a QUESTION and stops", async () => {
    const reply = scriptReplies([
      { text: "Merged.", command: blocked },
      { text: "I think it is fine." },
      {
        text: "main has your uncommitted edit to Chat.tsx.\nQUESTION: Discard it or stash it?\n",
        command: { run: "git status --short", printed: " M src/Chat.tsx" },
      },
    ]);
    scriptChecks(["MISSING: main wasn't updated", "MISSING: main wasn't updated"]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["waiting", "pending"]);
    expect(planRef.current![0].note).toBe("Discard it or stash it?");
    // No check after the question, no second round, no second step.
    expect(reply).toHaveBeenCalledTimes(3);
    expect(mockStreamChat).toHaveBeenCalledTimes(2);
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("asks in round 2 too", async () => {
    const reply = scriptReplies([
      { text: "Merged.", command: blocked },
      { text: "I think it is fine." },
      { text: "Tried a rerun." },
      { text: "QUESTION: Stash or discard?" },
    ]);
    scriptChecks(["MISSING: a", "MISSING: a", "MISSING: a"]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);
    expect(statuses(planRef)).toEqual(["waiting", "pending"]);
    expect(planRef.current![0].note).toBe("Stash or discard?");
    expect(reply).toHaveBeenCalledTimes(4);
  });

  it("passes the user's answer on when the waiting step reruns", async () => {
    const first = scriptReplies([
      { text: "Merged.", command: blocked },
      { text: "I think it is fine." },
      { text: "QUESTION: Discard it or stash it?" },
    ]);
    scriptChecks(["MISSING: main wasn't updated", "MISSING: main wasn't updated"]);
    const { cb, planRef } = setup(twoSteps(), first);
    await runPlan(cb);
    expect(planRef.current![0].status).toBe("waiting");

    // The user answers: PlanView sets the step pending with answer and asked.
    const asked = planRef.current![0].note!;
    planRef.current = planRef.current!.map((s, j) =>
      j === 0 ? { id: s.id, text: s.text, status: "pending", answer: "stash it", asked } : s,
    );
    const second = scriptReplies([{ text: "Stashed and merged." }, { text: "Deleted." }]);
    scriptChecks(["DONE", "DONE"]);
    cb.reply = second;
    await runPlan(cb);

    const prompt = second.mock.calls[0][0];
    expect(prompt).toContain("You asked: Discard it or stash it?");
    expect(prompt).toContain("The user answered your question: stash it");
    expect(prompt).toContain("Do step 1 of 2");
    expect(prompt.indexOf("The user answered")).toBeLessThan(prompt.indexOf("Do step 1"));
    expect(statuses(planRef)).toEqual(["done", "done"]);
    // The next step has no answer to send.
    expect(second.mock.calls[1][0]).not.toContain("The user answered");
  });

  it("reruns a waiting step without an answer as an ordinary step", async () => {
    const steps: PlanStep[] = [{ id: "s1", text: "Merge", status: "waiting", note: "Discard or stash?" }];
    const reply = scriptReplies([{ text: "Merged." }]);
    scriptChecks(["DONE"]);
    const { cb, planRef } = setup(steps, reply);
    await runPlan(cb);
    expect(reply.mock.calls[0][0]).not.toContain("The user answered");
    expect(statuses(planRef)).toEqual(["done"]);
  });

  it("keeps the answer on the step while it runs again", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Merge", status: "pending", answer: "stash it", asked: "Discard or stash?" },
    ];
    const reply = scriptReplies([{ text: "Merged." }]);
    scriptChecks(["DONE"]);
    const { cb, setStep } = setup(steps, reply);
    await runPlan(cb);
    expect(setStep.mock.calls[0]).toEqual(["s1", { status: "running", answer: "stash it", asked: "Discard or stash?" }]);
  });
});

describe("runPlan dispute path (unchanged by recovery)", () => {
  const file = { run: "src/limit.ts", printed: "export const limit = 300;", tool: "read_file" as const };

  it("holds a dispute that quotes what it read: disputed, no recovery round", async () => {
    const reply = scriptReplies([
      { text: "Set the limit.", command: file },
      { text: "The check is wrong.\n```\nexport const limit = 300;\n```\nSTEP DONE" },
    ]);
    scriptChecks(["MISSING: the limit isn't 300"]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["disputed", "pending"]);
    expect(planRef.current![0].note).toContain("Llama says the check is wrong: ");
    expect(reply).toHaveBeenCalledTimes(2);
    // Only the first check ran: no re-check, no round.
    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls.some(([p]) => p.includes("is blocked"))).toBe(false);
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("fails a dispute that didn't read the files: failed, no recovery round", async () => {
    const reply = scriptReplies([{ text: "Set the limit." }, { text: "The check is wrong. STEP DONE" }]);
    scriptChecks(["MISSING: the limit isn't 300"]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["failed", "pending"]);
    expect(planRef.current![0].note).toContain("without reading the files");
    expect(reply).toHaveBeenCalledTimes(2);
    expect(mockStreamChat).toHaveBeenCalledTimes(1);
  });

  it("re-checks after a dispute that fixed something and goes on when it's done", async () => {
    const reply = scriptReplies([
      { text: "Set the limit." },
      { text: "The check is right. STEP NOT DONE", command: { run: "sed -i s/30/300/ src/limit.ts", printed: "" } },
      { text: "Deleted." },
    ]);
    scriptChecks(["MISSING: the limit isn't 300", "DONE", "DONE"]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["done", "done"]);
    expect(reply).toHaveBeenCalledTimes(3);
    expect(reply.mock.calls.some(([p]) => p.includes("is blocked"))).toBe(false);
  });
});

describe("runPlan never starts a recovery round after a failed reply or an abort", () => {
  const noRound = (reply: { mock: { calls: unknown[][] } }) =>
    expect(reply.mock.calls.some(([p]) => (p as string).includes("is blocked"))).toBe(false);

  // The check's answers in order, then the user aborts: the signal fires and
  // the request throws, as fetch does.
  function scriptChecksThenAbort(answers: string[], ctl: { current: AbortController | null }) {
    const queue = [...answers];
    mockStreamChat.mockImplementation(async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
      const next = queue.shift();
      if (next === undefined) {
        ctl.current?.abort();
        throw new Error("The operation was aborted");
      }
      onDelta({ content: next });
      return { toolCalls: [] };
    });
  }
  const aborting = () => {
    const ctl: { current: AbortController | null } = { current: null };
    return { ctl, setAbort: vi.fn((c: AbortController | null) => void (c && (ctl.current = c))) };
  };

  it("stops with the step pending when the step's own reply failed", async () => {
    const reply = scriptReplies([{ text: "", ok: false, error: "TypeError: fetch failed" }]);
    scriptChecks([]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["pending", "pending"]);
    expect(planRef.current![0].note).toBe("The reply failed: Couldn't reach the llama server.");
    expect(reply).toHaveBeenCalledTimes(1);
    expect(mockStreamChat).not.toHaveBeenCalled();
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("stops with the step pending when the dispute retry's reply failed", async () => {
    const reply = scriptReplies([{ text: "Merged.", command: blocked }, { text: "", ok: false, error: "TypeError: fetch failed" }]);
    scriptChecks(["MISSING: main wasn't updated"]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["pending", "pending"]);
    expect(planRef.current![0].note).toContain("The reply failed");
    expect(reply).toHaveBeenCalledTimes(2);
    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    noRound(reply);
  });

  it("stops with the step pending when a recovery round's reply failed, with no second round", async () => {
    const reply = scriptReplies([
      { text: "Merged.", command: blocked },
      { text: "I think it is fine." },
      { text: "", ok: false, error: "The reply was cut off." },
    ]);
    scriptChecks(["MISSING: a", "MISSING: a"]);
    const { cb, planRef } = setup(twoSteps(), reply);
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["pending", "pending"]);
    expect(planRef.current![0].note).toContain("The reply failed");
    expect(reply).toHaveBeenCalledTimes(3);
    // No check after the failed round.
    expect(mockStreamChat).toHaveBeenCalledTimes(2);
  });

  it("keeps the answer when the rerun's reply fails", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Merge", status: "pending", answer: "stash it", asked: "Discard or stash?" },
    ];
    const reply = scriptReplies([{ text: "", ok: false, error: "TypeError: fetch failed" }]);
    const { cb, planRef } = setup(steps, reply);
    await runPlan(cb);
    expect(planRef.current![0]).toMatchObject({ status: "pending", answer: "stash it", asked: "Discard or stash?" });
  });

  it("stops without a note when the run is aborted during the first check", async () => {
    const { ctl, setAbort } = aborting();
    const reply = scriptReplies([{ text: "Merged.", command: blocked }]);
    scriptChecksThenAbort([], ctl);
    const { cb, planRef } = setup(twoSteps(), reply, { setAbort });
    await runPlan(cb);

    expect(ctl.current?.signal.aborted).toBe(true);
    expect(statuses(planRef)).toEqual(["pending", "pending"]);
    expect(planRef.current![0].note).toBeUndefined();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(cb.setError).not.toHaveBeenCalled();
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("starts no round when the run is aborted during the re-check after the dispute", async () => {
    const { ctl, setAbort } = aborting();
    const reply = scriptReplies([{ text: "Merged.", command: blocked }, { text: "I think it is fine." }]);
    scriptChecksThenAbort(["MISSING: a"], ctl);
    const { cb, planRef } = setup(twoSteps(), reply, { setAbort });
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["pending", "pending"]);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(cb.setError).not.toHaveBeenCalled();
    noRound(reply);
  });

  it("starts no second round when the run is aborted during the first round's check", async () => {
    const { ctl, setAbort } = aborting();
    const reply = scriptReplies([
      { text: "Merged.", command: blocked },
      { text: "I think it is fine." },
      { text: "Tried a rerun." },
    ]);
    scriptChecksThenAbort(["MISSING: a", "MISSING: a"], ctl);
    const { cb, planRef } = setup(twoSteps(), reply, { setAbort });
    await runPlan(cb);

    expect(statuses(planRef)).toEqual(["pending", "pending"]);
    expect(reply).toHaveBeenCalledTimes(3);
    expect(cb.setError).not.toHaveBeenCalled();
  });
});
