// The short report a thread sends back to the session that started it when its
// plan's run ends: one or two plain sentences, written by the model that ran
// it. Three parts, like sessionNaming.ts: the prompt, reading the answer, and a
// sentence of our own for when the model can't be asked or says nothing useful.
// The thread's messages are only read to write the prompt; they are never copied.
// No React in this file.

import { type Api, type ChatMessage, type Kind, type PlanStep, type StreamDelta, streamChat } from "../api.ts";
import { stepLine } from "./plan.ts";

export interface ReportInput {
  // The plan's one-sentence summary (or its first step).
  summary: string;
  // What the user asked for: the thread's first message.
  request?: string;
  steps: PlanStep[];
  // The thread's messages; only the model's last words are used.
  messages: ChatMessage[];
  // How the run ended if it went wrong, in its own plain words.
  error?: string | null;
  // The user stopped it.
  stopped?: boolean;
}

const NOTE_MAX = 200;
const LAST_MAX = 1500;
const REPORT_MAX = 400;

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trimEnd()}…` : one;
};

// Ends a piece of text with a full stop, unless it has some punctuation already.
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

// What each status means, in words the model can report from.
function stepState(s: PlanStep): string {
  switch (s.status) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "disputed":
      return "the check said it isn't done, and it is waiting for the user to decide";
    case "waiting":
      return "stopped to ask the user a question";
    case "running":
      return "was running when the plan ended";
    default:
      return "not run";
  }
}

// The prompt: what was asked, each step and how it ended, how the run ended,
// and the model's last words, then what to write.
export function reportPrompt(input: ReportInput): string {
  const lines = input.steps.map((s, i) => {
    const note = s.note ? ` (${clip(s.note, NOTE_MAX)})` : "";
    return `${i + 1}. ${clip(stepLine(s), NOTE_MAX)}: ${stepState(s)}${note}`;
  });
  const last = [...input.messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  const parts = [
    "A plan was run for the user in a separate thread, and it has ended. Write a short report for the user, in one or two plain sentences: what it did, or, if it didn't finish, what went wrong and what the user needs to do next. No lists, no headings, no greeting. Reply with only the report.",
    ...(input.request ? [`What the user asked for:\n${clip(input.request, 600)}`] : []),
    `The plan: ${clip(input.summary, NOTE_MAX)}`,
    `Steps:\n${lines.join("\n")}`,
    ...(input.stopped ? ["The user stopped the plan."] : []),
    ...(input.error ? [`The run ended with this error: ${clip(input.error, NOTE_MAX)}`] : []),
    ...(last ? [`The last thing the model said in the thread:\n${clip(last.content, LAST_MAX)}`] : []),
  ];
  return parts.join("\n\n");
}

// The model's answer as the report: whitespace tidied, the first two sentences,
// at most REPORT_MAX characters. Null when there is nothing in it.
export function parseReport(answer: string): string | null {
  const text = answer
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^report:\s*/i, "")
    .replace(/^["“]+|["”]+$/g, "")
    .trim();
  if (!text) return null;
  // A sentence ends at . ! or ? followed by a space or the end, so "notes.txt" or
  // "v1.2" stay whole. Sentences are joined with a space.
  const firstTwo = (text.match(/\S.*?[.!?]+(?=\s|$)|\S.*$/g) ?? [text]).slice(0, 2).join(" ").trim();
  return clip(firstTwo || text, REPORT_MAX);
}

// A plain sentence from the steps, for when the model can't write the report:
// the first problem, or how far it got.
export function fallbackReport(input: Pick<ReportInput, "steps" | "error" | "stopped">): string {
  const { steps } = input;
  if (steps.length === 0) return "The thread has no plan.";
  const done = steps.filter((s) => s.status === "done").length;
  const count = `${done} of ${steps.length} steps`;
  const at = (s: PlanStep) => steps.indexOf(s) + 1;
  const note = (s: PlanStep) => (s.note ? ` ${sentence(clip(s.note, NOTE_MAX))}` : "");

  const failed = steps.find((s) => s.status === "failed");
  if (failed) return `Step ${at(failed)} failed.${note(failed)} Open the thread to see what happened.`;
  const disputed = steps.find((s) => s.status === "disputed");
  if (disputed) {
    return `Step ${at(disputed)} didn't pass its check, and it is waiting for you to decide.${note(disputed)} Open the thread to look at it.`;
  }
  const waiting = steps.find((s) => s.status === "waiting");
  if (waiting) return `Step ${at(waiting)} stopped to ask you a question.${note(waiting)} Answer it in the thread to go on.`;
  if (steps.every((s) => s.status === "done")) return steps.length === 1 ? "The one step is done." : `All ${steps.length} steps are done.`;
  if (input.stopped) return `You paused it after ${count}. Continue in the thread to go on.`;
  if (input.error) return `It stopped after ${count}. ${sentence(clip(input.error, NOTE_MAX))} Continue in the thread to try again.`;
  return `${count} are done, and the plan isn't finished. Continue in the thread to go on.`;
}

// Asks the model for the report, streams its reply and reads it. Null when the
// request fails or the answer has nothing in it. One request, no tools.
export async function askForReport(
  input: ReportInput,
  connectorId: string,
  model: string,
  signal: AbortSignal,
  api?: Api,
  kind?: Kind,
): Promise<string | null> {
  const answer: string[] = [];
  try {
    await streamChat(
      {
        connectorId,
        kind,
        api,
        model,
        messages: [{ role: "user", content: reportPrompt(input) }],
        think: false,
        tools: [],
      },
      (d: StreamDelta) => {
        if (d.content) answer.push(d.content);
      },
      signal,
    );
    return parseReport(answer.join(""));
  } catch {
    return null;
  }
}
