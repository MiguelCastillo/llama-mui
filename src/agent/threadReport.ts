// The short report a thread sends back to the session that started it when its
// plan's run ends: a sentence or two saying it worked (plus a Follow-up line only
// when the user must act), or what went wrong and a Next line, written by the model
// that ran it. Three parts, like sessionNaming.ts: the prompt, reading the answer, and a
// sentence of our own for when the model can't be asked or says nothing useful.
// The thread's messages are only read to write the prompt; they are never copied.
// No React in this file.

import { type Api, type ChatMessage, type Kind, type PlanStep, type StreamDelta, streamChat } from "../api.ts";
import { threadResult } from "../planThread.ts";
import { stepLine } from "./plan.ts";

export interface ReportInput {
  // The plan's one-sentence summary (or its first step).
  summary: string;
  // What the user asked for: the thread's first message.
  request?: string;
  steps: PlanStep[];
  // The thread's messages; read by threadResult for the plan's result.
  messages: ChatMessage[];
  // How the run ended if it went wrong, in its own plain words.
  error?: string | null;
  // The user stopped it.
  stopped?: boolean;
}

const NOTE_MAX = 200;
// The report is asked to stay well under this; it is only a safety net.
const REPORT_MAX = 600;

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
// and the plan's result (threadResult), then what to write.
export function reportPrompt(input: ReportInput): string {
  const lines = input.steps.map((s, i) => {
    const note = s.note ? ` (${clip(s.note, NOTE_MAX)})` : "";
    return `${i + 1}. ${clip(stepLine(s), NOTE_MAX)}: ${stepState(s)}${note}`;
  });
  // The plan's real result (not the thread's last message, which can be a
  // verdict line or a reply to something said after the plan).
  const result = threadResult({ plan: input.steps, messages: input.messages });
  const parts = [
    "A plan was run for the user in a separate thread, and it has ended. Write a short report for the chat that started it, which can't see the thread. " +
      "If every step is done, say in one or two plain sentences that it worked: no file lists, numbers or commands. " +
      "Add a line starting \"Follow-up:\" only if the user must do something after this (for example restart the server, commit, answer a question). " +
      "If it didn't all work, say in plain words what went wrong, and end with a line starting \"Next:\" giving the one concrete move to make. " +
      "Plain text, under about 400 characters, no headings, no greeting. Reply with only the report.",
    ...(input.request ? [`What the user asked for:\n${clip(input.request, 600)}`] : []),
    `The plan: ${clip(input.summary, NOTE_MAX)}`,
    `Steps:\n${lines.join("\n")}`,
    ...(input.stopped ? ["The user stopped the plan."] : []),
    ...(input.error ? [`The run ended with this error: ${clip(input.error, NOTE_MAX)}`] : []),
    `How the thread ended:\n${result}`,
  ];
  return parts.join("\n\n");
}

// The model's answer as the report: a label and quotes taken off, spaces
// tidied, line breaks kept (the Follow-up line is on its own line), at most
// REPORT_MAX characters. Null when there is nothing in it.
export function parseReport(answer: string): string | null {
  const text = answer
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/^report:\s*/i, "")
    .replace(/^["“]+|["”]+$/g, "")
    .trim();
  if (!text) return null;
  return text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX).trimEnd()}…` : text;
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
        // One-shot, with no settings of the model's.
        purpose: { kind: "background" },
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
