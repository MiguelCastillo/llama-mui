import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ChatMessage, type PlanStep } from "../../api";

const { mockStreamChat } = vi.hoisted(() => ({
  mockStreamChat: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, streamChat: mockStreamChat };
});

import { runPlan, type RunPlanCallbacks } from "../agent";

// No real model: every check says DONE, and every reply just answers.

function allChecksPass() {
  mockStreamChat.mockImplementation(async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
    onDelta({ content: "DONE" });
    return { toolCalls: [] };
  });
}

function okReply(log?: string[]) {
  return vi.fn(async (prompt: string, before: ChatMessage[], opts?: { planStep?: string }) => {
    log?.push(`reply ${opts?.planStep}`);
    const planStep = opts?.planStep;
    return {
      ok: true,
      messages: [...before, { role: "user", content: prompt, planStep }, { role: "assistant", content: "Done.", planStep }] as ChatMessage[],
    };
  });
}

function setup(steps: PlanStep[], reply: RunPlanCallbacks["reply"], overrides?: Partial<RunPlanCallbacks>) {
  const planRef = { current: steps as PlanStep[] | null };
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
  return { cb, planRef };
}

const threeSteps = (): PlanStep[] => [
  { id: "s1", text: "One", status: "pending" },
  { id: "s2", text: "Two", status: "pending" },
  { id: "s3", text: "Three", status: "pending" },
];
const statuses = (planRef: { current: PlanStep[] | null }) => planRef.current!.map((s) => s.status);
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockStreamChat.mockReset();
  allChecksPass();
});

describe("runPlan gate", () => {
  it("runs the gate before each step, after the previous step is done", async () => {
    const log: string[] = [];
    const reply = okReply(log);
    const { cb, planRef } = setup(threeSteps(), reply, {
      gate: async () => {
        log.push("gate");
        return true;
      },
    });
    await runPlan(cb);
    expect(log).toEqual(["gate", "reply s1", "gate", "reply s2", "gate", "reply s3"]);
    expect(statuses(planRef)).toEqual(["done", "done", "done"]);
  });

  it("does not call the gate when no step is left", async () => {
    const steps = threeSteps().map((s) => ({ ...s, status: "done" as const }));
    const gate = vi.fn(async () => true);
    const { cb } = setup(steps, okReply(), { gate });
    await runPlan(cb);
    expect(gate).not.toHaveBeenCalled();
  });

  it("does not call the gate for a disputed step", async () => {
    const steps = threeSteps();
    steps[0] = { ...steps[0], status: "disputed", note: "x" };
    const gate = vi.fn(async () => true);
    const reply = okReply();
    const { cb } = setup(steps, reply, { gate });
    await runPlan(cb);
    expect(gate).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("a gate held open delays the next step, and the step in flight finishes first", async () => {
    const reply = okReply();
    let release: (go: boolean) => void = () => {};
    let held = false;
    let calls = 0;
    const { cb, planRef } = setup(threeSteps(), reply, {
      gate: () => {
        // Hold from the second pass on, like Pause pressed during step 1.
        if (++calls !== 2) return Promise.resolve(true);
        held = true;
        return new Promise<boolean>((r) => (release = r));
      },
    });
    const done = runPlan(cb);
    await tick();
    await tick();
    expect(held).toBe(true);
    // Step 1 and its check finished; step 2 hasn't started.
    expect(statuses(planRef)).toEqual(["done", "pending", "pending"]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(cb.planRunningRef.current).toBe(true);

    release(true);
    await done;
    expect(statuses(planRef)).toEqual(["done", "done", "done"]);
    expect(reply).toHaveBeenCalledTimes(3);
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("false ends the plan with the later steps pending", async () => {
    const reply = okReply();
    let calls = 0;
    const { cb, planRef } = setup(threeSteps(), reply, {
      gate: async () => ++calls < 2,
    });
    await runPlan(cb);
    expect(statuses(planRef)).toEqual(["done", "pending", "pending"]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("false at the first pass runs nothing", async () => {
    const reply = okReply();
    const { cb, planRef } = setup(threeSteps(), reply, { gate: async () => false });
    await runPlan(cb);
    expect(statuses(planRef)).toEqual(["pending", "pending", "pending"]);
    expect(reply).not.toHaveBeenCalled();
    expect(cb.planRunningRef.current).toBe(false);
  });

  it("reads the plan again after the gate, so a step edited while it held runs as edited", async () => {
    const reply = okReply();
    let calls = 0;
    const { cb, planRef } = setup(threeSteps(), reply, {
      gate: async () => {
        if (++calls === 2) {
          planRef.current = planRef.current!.map((s) => (s.id === "s2" ? { ...s, text: "Two, edited" } : s));
        }
        return true;
      },
    });
    await runPlan(cb);
    expect(reply.mock.calls[1][0]).toContain("Two, edited");
  });

  it("runs as before without a gate", async () => {
    const reply = okReply();
    const { cb, planRef } = setup(threeSteps(), reply);
    await runPlan(cb);
    expect(statuses(planRef)).toEqual(["done", "done", "done"]);
  });
});
