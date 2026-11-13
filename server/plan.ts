// update_plan: the model writes down the steps of a task that changes files.
// Small models say they're done when they aren't, so chat runs the plan one
// step per turn and checks each step (see src/Plan.tsx). The server only
// checks the steps' shape; chat keeps the plan and shows it. The rules for
// when plans are made and who marks steps done are in docs/guide.md, "How plans work".

import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

const MAX_STEPS = 12;
export const MAX_STEP_CHARS = 600;
export const MAX_SUMMARY_CHARS = 80;
const MAX_PLAN_SUMMARY_CHARS = 200;

// When to plan is a matter of working style, so it is the persona's to say
// (personas/Builder.md says it); the mechanics below stay fixed.
export const planInstructions =
  "Before calling update_plan, write two or three plain sentences to the user, as if to someone who hasn't read the code: " +
  "what is wrong or missing as they see it, what will look or work differently afterwards, and what stays the same. " +
  "Use no file names or internal names unless the user used them. " +
  "After the call, reply with one plain line pointing at the plan. " +
  "Each step is one change you can make in one turn, written so " +
  "someone could check it from the diff alone. When a message says \"Do step N\", do only that step, then " +
  "reply with one line saying what you changed. Call update_plan again only if the plan itself has to change. " +
  "You may also include a `context` field: a brief description of the decisions, constraints, and other details from the conversation that each step needs (each step starts without the chat). Keep it short. " +
  "Give every step a `summary`: a to-do line the user reads, a short imperative phrase of at most about 8 words " +
  "saying what gets done in everyday words, with no file paths unless the step is about one. " +
  "Examples: \"Make a stuck step retry twice\", \"Stop asking before making a worktree\", \"Repair chats with unfinished calls\". " +
  "The step's `text` is the instruction for you, and can be longer. " +
  "You may also include a plan-level `summary`: one plain sentence saying what will be different for the user, the same effect you described to them.";

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
              summary: {
                type: "string",
                description:
                  `The to-do line the user reads: a short imperative phrase, at most about 8 words (${MAX_SUMMARY_CHARS} characters max), ` +
                  'saying what gets done, no file paths unless the step is about one. E.g. "Make a stuck step retry twice", ' +
                  '"Stop asking before making a worktree", "Repair chats with unfinished calls".',
              },
              text: {
                type: "string",
                description: `The instruction for this step: what it changes, written so someone could check it from the diff alone. At most ${MAX_STEP_CHARS} characters.`,
              },
            },
            required: ["summary", "text"],
          },
        },
        summary: {
          type: "string",
          description:
            "Optional. One plain sentence saying what will be different for the user once the plan is done, the same effect you explained to them in plain words before calling this.",
        },
        context: {
          type: "string",
          description:
            "Brief description of the decisions, constraints, and other details from the conversation that each step needs (each step starts without the chat).",
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
      const n = i + 1;
      const text = typeof s === "string" ? s : s?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new ToolError(`step ${n} has no text; give each step {summary, text}, where text is the instruction`);
      }
      if (text.length > MAX_STEP_CHARS) {
        throw new ToolError(
          `step ${n} text is ${text.length} characters, over the ${MAX_STEP_CHARS} limit; shorten it or split the step`,
        );
      }
      const summary = typeof s === "string" ? undefined : s?.summary;
      if (typeof summary !== "string" || !summary.trim()) {
        throw new ToolError(
          `step ${n} has no summary; add a short imperative to-do line, e.g. "Make a stuck step retry twice"`,
        );
      }
      if (summary.length > MAX_SUMMARY_CHARS) {
        throw new ToolError(
          `step ${n} summary is ${summary.length} characters, over the ${MAX_SUMMARY_CHARS} limit; make it a short to-do line of about 8 words and move detail into text`,
        );
      }
    }
    const planSummary = args.summary;
    if (planSummary !== undefined && planSummary !== null) {
      if (typeof planSummary !== "string") throw new ToolError("summary must be a short sentence (string)");
      if (planSummary.length > MAX_PLAN_SUMMARY_CHARS) {
        throw new ToolError(
          `plan summary is ${planSummary.length} characters, over the ${MAX_PLAN_SUMMARY_CHARS} limit; use one short sentence`,
        );
      }
    }
    return `Plan saved: ${steps.length} step${steps.length === 1 ? "" : "s"}. Now tell the user in plain words what the plan changes for them, then stop; they run it.`;
  },
};

export const PLAN_TOOLS = [updatePlan];
