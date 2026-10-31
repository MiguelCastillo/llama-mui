// update_plan: the model writes down the steps of a task that changes files.
// Small models say they're done when they aren't, so chat runs the plan one
// step per turn and checks each step (see src/Plan.tsx). The server only
// checks the steps' shape; chat keeps the plan and shows it. The rules for
// when plans are made and who marks steps done are in README, "How plans work".

import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

const MAX_STEPS = 12;
const MAX_STEP_CHARS = 300;

export const planInstructions =
  "For a task that changes files, first call update_plan with the steps, then stop and wait: " +
  "the user reviews the plan and runs it. Each step is one change you can make in one turn, written so " +
  "someone could check it from the diff alone. When a message says \"Do step N\", do only that step, then " +
  "reply with one line saying what you changed. Call update_plan again only if the plan itself has to change. " +
  "Questions that don't change files need no plan.";

const updatePlan: ToolSpec = {
  name: "update_plan",
  group: "plan",
  label: "Plan tasks",
  summary: "Write a task's steps as a checklist that chat runs and checks one step at a time.",
  definition: fn(
    "update_plan",
    "Write or replace the plan for the current task: the whole list of steps, in order. Chat shows it as a " +
      "checklist, runs one step per turn and checks each step.",
    {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: `The steps in order, at most ${MAX_STEPS}.`,
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "What this step changes, in one sentence." },
            },
            required: ["text"],
          },
        },
      },
      required: ["steps"],
    },
  ),
  async run(_ctx, args) {
    const steps = Array.isArray(args.steps) ? args.steps : null;
    if (!steps?.length) throw new ToolError("steps must be a non-empty list");
    if (steps.length > MAX_STEPS) throw new ToolError(`at most ${MAX_STEPS} steps; merge some`);
    for (const [i, s] of steps.entries()) {
      const text = typeof s === "string" ? s : s?.text;
      if (typeof text !== "string" || !text.trim()) throw new ToolError(`step ${i + 1} has no text`);
      if (text.length > MAX_STEP_CHARS) throw new ToolError(`step ${i + 1} is over ${MAX_STEP_CHARS} characters`);
    }
    return `Plan saved: ${steps.length} step${steps.length === 1 ? "" : "s"}. Stop here; the user runs it.`;
  },
};

export const PLAN_TOOLS = [updatePlan];
