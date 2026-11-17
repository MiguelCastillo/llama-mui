// update_plan: the model writes down the steps of a task that changes files.
// Small models say they're done when they aren't, so chat runs the plan one
// step per turn and checks each step (see src/Plan.tsx). The server only
// checks the steps' shape; chat keeps the plan and shows it. The rules for
// when plans are made and who marks steps done are in docs/guide.md, "How plans work".

import { log } from "./log.ts";
import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

const MAX_STEPS = 12;

// How long things should be: the guideline the tool description gives the
// model. The model writes every character, and the user can't shorten a step,
// so going over is not a reason to lose the plan: it is saved, the model is
// told in the result, and the server log gets one line (see logOver) so we can
// see how often it happens and by how much. Small models that write essays are
// the reason the guideline exists: a long step is harder to check in one turn.
export const MAX_STEP_CHARS = 600;
export const MAX_SUMMARY_CHARS = 80;
export const MAX_PLAN_SUMMARY_CHARS = 200;
// Past these the call is refused instead: that is not a long step but a runaway
// (or text in the wrong field), and the model can fix it with one more call.
export const REFUSE_STEP_CHARS = 3000;
export const REFUSE_SUMMARY_CHARS = 400;
export const REFUSE_PLAN_SUMMARY_CHARS = 1000;

// A field that went over its guideline: where, how long, and the guideline.
// Plain numbers only; the words themselves never go in the log.
interface Over {
  step?: number;
  field: "text" | "summary" | "planSummary";
  chars: number;
  limit: number;
}

// One line per call that had anything over, `refused` when it was past a hard
// limit as well. No step text, summary or context: only where and how long.
function logOver(over: Over[], steps: number, refused: boolean): void {
  if (over.length) log("plan.over_guideline", { steps, refused, over });
}

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
  effect: "change",
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
                  `The to-do line the user reads: a short imperative phrase, at most about 8 words (aim for ${MAX_SUMMARY_CHARS} characters max), ` +
                  'saying what gets done, no file paths unless the step is about one. E.g. "Make a stuck step retry twice", ' +
                  '"Stop asking before making a worktree", "Repair chats with unfinished calls".',
              },
              text: {
                type: "string",
                description: `The instruction for this step: what it changes, written so someone could check it from the diff alone. Aim for at most ${MAX_STEP_CHARS} characters; a longer step is saved but harder to check, so split it.`,
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
    const over: Over[] = [];
    let refusal: string | undefined;
    for (const [i, s] of steps.entries()) {
      const n = i + 1;
      const text = typeof s === "string" ? s : s?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new ToolError(`step ${n} has no text; give each step {summary, text}, where text is the instruction`);
      }
      if (text.length > MAX_STEP_CHARS) over.push({ step: n, field: "text", chars: text.length, limit: MAX_STEP_CHARS });
      if (text.length > REFUSE_STEP_CHARS) {
        refusal ??= `step ${n} text is ${text.length} characters, far over the ${MAX_STEP_CHARS} guideline; split it into several steps`;
      }
      const summary = typeof s === "string" ? undefined : s?.summary;
      if (typeof summary !== "string" || !summary.trim()) {
        throw new ToolError(
          `step ${n} has no summary; add a short imperative to-do line, e.g. "Make a stuck step retry twice"`,
        );
      }
      if (summary.length > MAX_SUMMARY_CHARS) over.push({ step: n, field: "summary", chars: summary.length, limit: MAX_SUMMARY_CHARS });
      if (summary.length > REFUSE_SUMMARY_CHARS) {
        refusal ??= `step ${n} summary is ${summary.length} characters; make it a short to-do line of about 8 words and move detail into text`;
      }
    }
    const planSummary = args.summary;
    if (planSummary !== undefined && planSummary !== null) {
      if (typeof planSummary !== "string") throw new ToolError("summary must be a short sentence (string)");
      if (planSummary.length > MAX_PLAN_SUMMARY_CHARS) over.push({ field: "planSummary", chars: planSummary.length, limit: MAX_PLAN_SUMMARY_CHARS });
      if (planSummary.length > REFUSE_PLAN_SUMMARY_CHARS) {
        refusal ??= `plan summary is ${planSummary.length} characters; use one short sentence`;
      }
    }
    logOver(over, steps.length, !!refusal);
    if (refusal) throw new ToolError(refusal);
    const saved = `Plan saved: ${steps.length} step${steps.length === 1 ? "" : "s"}.`;
    // Said to the model, not the user: what to do better next time.
    const note = over.length
      ? ` Longer than the guideline (shorter is easier to check): ${over
          .map((o) => `${o.step ? `step ${o.step} ` : "plan "}${o.field === "planSummary" ? "summary" : o.field} ${o.chars} characters (guideline ${o.limit})`)
          .join("; ")}.`
      : "";
    return `${saved}${note} Now tell the user in plain words what the plan changes for them, then stop; they run it.`;
  },
};

export const PLAN_TOOLS = [updatePlan];
