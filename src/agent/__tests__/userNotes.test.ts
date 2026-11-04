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
import { stepPrompt } from "../plan";

// No real model: every check says DONE, and every reply just answers. The
// prompts the steps get are what these tests read.

const steps = (): PlanStep[] => [
  { id: "s1", text: "One", status: "pending" },
  { id: "s2", text: "Two", status: "pending" },
  { id: "s3", text: "Three", status: "pending" },
];

function setup(overrides?: Partial<RunPlanCallbacks>) {
  const prompts: string[] = [];
  const histories: ChatMessage[][] = [];
  const planRef = { current: steps() as PlanStep[] | null };
  const cb: RunPlanCallbacks = {
    connector: { id: "test-connector" } as any,
    model: "test-model",
    abort: null,
    planRunningRef: { current: false },
    setPlanRunning: vi.fn(),
    messages: [{ role: "user", content: "the request" }],
    planRef,
    setStep: (id, patch) => {
      planRef.current = planRef.current!.map((s) => (s.id === id ? { id: s.id, text: s.text, ...patch } : s));
    },
    reply: async (prompt, before, opts) => {
      prompts.push(prompt);
      histories.push(before);
      return {
        ok: true,
        messages: [...before, { role: "user", content: prompt, planStep: opts?.planStep }, { role: "assistant", content: "Done.", planStep: opts?.planStep }] as ChatMessage[],
      };
    },
    setError: vi.fn(),
    setAbort: vi.fn(),
    modelLoaded: vi.fn().mockResolvedValue(true),
    models: [{ id: "test-model" }] as any[],
    workingDir: null,
    attachments: [],
    checkCommands: {},
    attachedPaths: () => [],
    sessionId: "test-session",
    thinkOn: false,
    toolDefinitions: [],
    ...overrides,
  };
  return { cb, prompts, histories };
}

beforeEach(() => {
  mockStreamChat.mockReset();
  mockStreamChat.mockImplementation(async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
    onDelta({ content: "DONE" });
    return { toolCalls: [] };
  });
});

describe("stepPrompt with messages from the user", () => {
  it("lists them just before the step to do, and leaves the prompt alone without any", () => {
    const list = steps();
    expect(stepPrompt(list, 1, undefined, [], null, [])).toBe(stepPrompt(list, 1));
    const prompt = stepPrompt(list, 1, "the request", [], null, ["Use tabs", "No tests"]);
    expect(prompt).toContain("The user sent these messages while the plan was running:\n- Use tabs\n- No tests");
    expect(prompt.indexOf("- Use tabs")).toBeLessThan(prompt.indexOf("Do step 2 of 3"));
    expect(prompt.indexOf("The task the plan is for")).toBeLessThan(prompt.indexOf("- Use tabs"));
  });
});

describe("runPlan userNotes", () => {
  it("asks before each step, after the gate, with the step's id and number", async () => {
    const log: string[] = [];
    const { cb } = setup({
      gate: async () => (log.push("gate"), true),
      userNotes: (step) => (log.push(`notes ${step.id} #${step.number}`), []),
    });
    await runPlan(cb);
    expect(log).toEqual(["gate", "notes s1 #1", "gate", "notes s2 #2", "gate", "notes s3 #3"]);
  });

  it("puts a message in the prompt of the step that follows and of every step after", async () => {
    let sent = false;
    const { cb, prompts } = setup({
      userNotes: (step) => {
        if (step.number !== 2 || sent) return [];
        sent = true;
        return [{ role: "user", content: "Use tabs", seenByStep: 2 }];
      },
    });
    await runPlan(cb);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).not.toContain("Use tabs");
    expect(prompts[1]).toContain("- Use tabs");
    expect(prompts[2]).toContain("- Use tabs");
  });

  it("adds the message to the chat before the step, not into the step's own messages", async () => {
    const { cb, histories } = setup({
      userNotes: (step) => (step.number === 2 ? [{ role: "user", content: "Use tabs", seenByStep: 2 }] : []),
    });
    await runPlan(cb);
    // Step 2's history has the message, after step 1's turn and before step 2's own.
    expect(histories[1].map((m) => m.content)).toEqual(["the request", expect.stringContaining("Do step 1"), "Done.", "Use tabs"]);
    expect(histories[1].at(-1)).toEqual({ role: "user", content: "Use tabs", seenByStep: 2 });
  });

  it("without fresh steps the prompt doesn't repeat what the history holds", async () => {
    const { cb, prompts, histories } = setup({
      freshSteps: false,
      userNotes: (step) => (step.number === 2 ? [{ role: "user", content: "Use tabs", seenByStep: 2 }] : []),
    });
    await runPlan(cb);
    expect(prompts[1]).not.toContain("Use tabs");
    expect(histories[1].some((m) => m.content === "Use tabs")).toBe(true);
  });

  it("runs as before without the hook", async () => {
    const { cb, prompts } = setup();
    await runPlan(cb);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).not.toContain("messages while the plan was running");
  });
});
