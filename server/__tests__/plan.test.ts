import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STEP_CHARS, MAX_SUMMARY_CHARS, PLAN_TOOLS, REFUSE_PLAN_SUMMARY_CHARS, REFUSE_STEP_CHARS, REFUSE_SUMMARY_CHARS, planInstructions } from "../plan.ts";
import { ToolError, type ToolContext } from "../toolkit.ts";

// The server log is replaced, so these tests never write to a real one.
const logged = vi.hoisted(() => [] as { event: string; fields: any }[]);
vi.mock("../log.ts", () => ({ log: (event: string, fields: any) => void logged.push({ event, fields }) }));
beforeEach(() => void (logged.length = 0));

const ctx = { store: {}, chatId: "c", attachments: [], approved: null, todos: [] } as unknown as ToolContext;
const updatePlan = PLAN_TOOLS.find((t) => t.name === "update_plan")!;
const run = (args: Record<string, unknown>) => updatePlan.run(ctx, args);
const step = (over: Record<string, unknown> = {}) => ({ summary: "Make a stuck step retry twice", text: "Edit src/agent/agent.ts", ...over });

describe("update_plan", () => {
  it("accepts steps with a summary and text", async () => {
    const tail = "Now tell the user in plain words what the plan changes for them, then stop; they run it.";
    expect(await run({ steps: [step(), step({ summary: "Add a test" })] })).toBe(`Plan saved: 2 steps. ${tail}`);
    expect(await run({ steps: [step()] })).toBe(`Plan saved: 1 step. ${tail}`);
  });

  it("accepts an optional plan summary and context", async () => {
    await expect(run({ steps: [step()], summary: "Retry stuck steps.", context: "see agent.ts" })).resolves.toMatch(/Plan saved/);
    await expect(run({ steps: [step()], summary: null })).resolves.toMatch(/Plan saved/);
  });

  it("refuses a plan summary that is not text, and one far over its guideline", async () => {
    await expect(run({ steps: [step()], summary: 5 })).rejects.toThrow(/summary must be a short sentence/);
    await expect(run({ steps: [step()], summary: "x".repeat(REFUSE_PLAN_SUMMARY_CHARS + 1) })).rejects.toThrow(/one short sentence/);
  });

  it("refuses a step without a summary, and says what to add", async () => {
    const err = await run({ steps: [step(), { text: "Do the thing" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/step 2 has no summary/);
    expect(err.message).toMatch(/Make a stuck step retry twice/);
    await expect(run({ steps: [step({ summary: "  " })] })).rejects.toThrow(/step 1 has no summary/);
    await expect(run({ steps: ["just a string"] })).rejects.toThrow(/step 1 has no summary/);
  });

  it("saves a summary over 80 characters, tells the model, and logs it", async () => {
    expect(MAX_SUMMARY_CHARS).toBe(80);
    const out = await run({ steps: [step({ summary: "x".repeat(81) })] });
    expect(out).toMatch(/^Plan saved: 1 step\. Longer than the guideline.*step 1 summary 81 characters \(guideline 80\)/);
    expect(logged).toEqual([{ event: "plan.over_guideline", fields: { steps: 1, refused: false, over: [{ step: 1, field: "summary", chars: 81, limit: 80 }] } }]);
  });

  it("says nothing and logs nothing for a summary of exactly 80", async () => {
    expect(await run({ steps: [step({ summary: "x".repeat(80) })] })).toMatch(/^Plan saved: 1 step\. Now tell/);
    expect(logged).toEqual([]);
  });

  it("refuses a step without text, and says to give both fields", async () => {
    await expect(run({ steps: [{ summary: "Add a test" }] })).rejects.toThrow(/step 1 has no text; give each step \{summary, text\}/);
    await expect(run({ steps: [step({ text: " " })] })).rejects.toThrow(/no text/);
  });

  it("saves a step of exactly 600 characters without a word or a log line", async () => {
    expect(MAX_STEP_CHARS).toBe(600);
    expect(await run({ steps: [step({ text: "t".repeat(600) })] })).toMatch(/^Plan saved: 1 step\. Now tell/);
    expect(logged).toEqual([]);
  });

  it("saves a step of 601 characters, tells the model it was long, and logs the length, not the words", async () => {
    const out = await run({ steps: [step(), step({ text: "secret words ".repeat(60) })] });
    expect(out).toMatch(/^Plan saved: 2 steps\. Longer than the guideline \(shorter is easier to check\): step 2 text 780 characters \(guideline 600\)\. Now tell/);
    expect(logged).toEqual([{ event: "plan.over_guideline", fields: { steps: 2, refused: false, over: [{ step: 2, field: "text", chars: 780, limit: 600 }] } }]);
    expect(JSON.stringify(logged)).not.toContain("secret");
  });

  it("writes one log line for a call with several things over, including the plan summary", async () => {
    const out = await run({ steps: [step({ text: "a".repeat(700) }), step({ summary: "b".repeat(90), text: "c".repeat(650) })], summary: "d".repeat(250) });
    expect(out).toMatch(/step 1 text 700 characters \(guideline 600\); step 2 text 650 characters \(guideline 600\); step 2 summary 90 characters \(guideline 80\); plan summary 250 characters \(guideline 200\)/);
    expect(logged).toHaveLength(1);
    expect(logged[0].fields.over).toEqual([
      { step: 1, field: "text", chars: 700, limit: 600 },
      { step: 2, field: "text", chars: 650, limit: 600 },
      { step: 2, field: "summary", chars: 90, limit: 80 },
      { field: "planSummary", chars: 250, limit: 200 },
    ]);
  });

  it("refuses a runaway step, and logs it as refused", async () => {
    const err = await run({ steps: [step({ text: "t".repeat(REFUSE_STEP_CHARS + 1) })] }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/step 1 text is 3001 characters, far over the 600 guideline; split it into several steps/);
    expect(logged[0].fields).toMatchObject({ refused: true, over: [{ step: 1, field: "text", chars: 3001, limit: 600 }] });
    const long = await run({ steps: [step({ summary: "s".repeat(REFUSE_SUMMARY_CHARS + 1) })] }).catch((e) => e);
    expect(long.message).toMatch(/step 1 summary is 401 characters; make it a short to-do line/);
  });

  it("does not log a call that is refused for its shape alone", async () => {
    await run({ steps: [{ summary: "Add a test" }] }).catch(() => {});
    await run({ steps: Array.from({ length: 13 }, () => step()) }).catch(() => {});
    expect(logged).toEqual([]);
  });

  it("keeps the 12-step cap and needs at least one step", async () => {
    await expect(run({ steps: Array.from({ length: 12 }, () => step()) })).resolves.toMatch(/12 steps/);
    await expect(run({ steps: Array.from({ length: 13 }, () => step()) })).rejects.toThrow(/at most 12 steps; merge some/);
    await expect(run({ steps: [] })).rejects.toThrow(/non-empty/);
    await expect(run({})).rejects.toThrow(/non-empty/);
  });

  it("asks for summary and text in the tool definition", () => {
    const params = (updatePlan.definition as any).function.parameters;
    expect(params.required).toEqual(["steps"]);
    expect(params.properties.steps.items.required).toEqual(["summary", "text"]);
    expect(params.properties.summary).toBeDefined();
  });

  it("tells the model how to write summaries", () => {
    expect(planInstructions).toContain("Make a stuck step retry twice");
    expect(planInstructions).toContain("Repair chats with unfinished calls");
  });
});
