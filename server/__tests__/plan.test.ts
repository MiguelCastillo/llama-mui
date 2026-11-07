import { describe, expect, it } from "vitest";
import { MAX_STEP_CHARS, MAX_SUMMARY_CHARS, PLAN_TOOLS, planInstructions } from "../plan.ts";
import { ToolError, type ToolContext } from "../toolkit.ts";

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

  it("refuses a plan summary that is not a short sentence", async () => {
    await expect(run({ steps: [step()], summary: 5 })).rejects.toThrow(/summary must be a short sentence/);
    await expect(run({ steps: [step()], summary: "x".repeat(201) })).rejects.toThrow(/one short sentence/);
  });

  it("refuses a step without a summary, and says what to add", async () => {
    const err = await run({ steps: [step(), { text: "Do the thing" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/step 2 has no summary/);
    expect(err.message).toMatch(/Make a stuck step retry twice/);
    await expect(run({ steps: [step({ summary: "  " })] })).rejects.toThrow(/step 1 has no summary/);
    await expect(run({ steps: ["just a string"] })).rejects.toThrow(/step 1 has no summary/);
  });

  it("refuses a summary over 80 characters, and accepts exactly 80", async () => {
    expect(MAX_SUMMARY_CHARS).toBe(80);
    const err = await run({ steps: [step({ summary: "x".repeat(81) })] }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/step 1 summary is 81 characters, over the 80 limit/);
    expect(err.message).toMatch(/move detail into text/);
    await expect(run({ steps: [step({ summary: "x".repeat(80) })] })).resolves.toMatch(/Plan saved/);
  });

  it("refuses a step without text, and says to give both fields", async () => {
    await expect(run({ steps: [{ summary: "Add a test" }] })).rejects.toThrow(/step 1 has no text; give each step \{summary, text\}/);
    await expect(run({ steps: [step({ text: " " })] })).rejects.toThrow(/no text/);
  });

  it("accepts a 600-character text and refuses 601", async () => {
    expect(MAX_STEP_CHARS).toBe(600);
    await expect(run({ steps: [step({ text: "t".repeat(600) })] })).resolves.toMatch(/Plan saved/);
    const err = await run({ steps: [step({ text: "t".repeat(601) })] }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/step 1 text is 601 characters, over the 600 limit; shorten it or split the step/);
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
