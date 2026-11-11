// The chat that started a thread reads how it went, in two steps that cost
// more the further they go (the note's own short report, written when the
// thread ended, comes first and is always in the chat):
//
//  - read_thread: the steps and the thread's own final message, whole. Nothing
//    is asked of a model, so it costs only the size of that message.
//  - summarize_thread: asks the thread for a summary. A thread is a nested session that ran a plan on its own (see
// src/planThread.ts); the chat that started it gets a note with a one-or-two-
// sentence report, and when the model there needs more it calls this tool. The
// tool gives the thread's model the whole record of the thread and asks it to
// write a summary for the chat (with an optional focus the chat wants), so what
// comes back is as long as it needs to be, not the thread's raw messages and not
// a cut of them. One request, no tools, nothing written to the thread.
//
// The chat's threads come from its saved session (ToolContext.chatId), not from
// anything the model passes, so the tool reads only what this chat started. The
// thread's own model is asked (it may have been changed from the chat's) through
// the chat's connector. If the request fails, the answer says so and gives the
// steps and the short report instead.

import { type ChatMessage, type PlanStep, type PlanThread, streamChat } from "../src/api.ts";
import { filesChanged, stepOutput } from "../src/agent/plan.ts";
import { type ThreadResultParts, threadResultParts, threadStatus, worktreeLines } from "../src/planThread.ts";
import { liveRun } from "./runHub.ts";
import { readSession } from "./sessionFile.ts";
import { ToolError, type ToolSpec, fn } from "./toolkit.ts";
import { worktreeStatuses } from "./worktreeStatus.ts";

// How long the thread's model has to write the summary.
export const SUMMARY_TIMEOUT_MS = 180_000;
const NOTE_MAX = 300;
// The most read_thread answers for one step. When it is more, the start is cut:
// what a step said and ran last is what explains how it ended.
export const STEP_DETAIL_MAX = 6000;
// The most read_thread's overview answers, whatever the thread holds. What the
// chat needs to decide comes first and is kept whole up to its own limit: the
// outcome, the result (its end, which is what the thread said last), what to do
// next, and the note of the step that went wrong. The other steps' notes, then
// the other steps, then the files and worktrees only take what room is left.
export const OVERVIEW_MAX = 4000;
export const RESULT_MAX = 1500;
export const PROBLEM_NOTE_MAX = 800;
export const OTHER_NOTE_MAX = 200;
const STEP_HEAD_MAX = 240;
const SUMMARY_MAX = 200;

export const threadInstructions =
  "Threads do work apart from this chat, in parallel; this chat stays on the main train of thought with the user, " +
  "so keep the thread's details out of it and pass on only what the user needs. When a plan ran in a thread, the " +
  "chat gets a note with a short report, and a Chat update lists how each thread ended: start from those. When a " +
  "thread ended done, say so in one line and don't recap its results; for trouble, state what went wrong and the " +
  "next move. When a " +
  "thread ended failed or not finished, or its report mentions a failed or disputed check, a step not done, " +
  "something unconfirmed, or work that was not committed, call read_thread on your own, before you answer and " +
  "without waiting to be asked. Also call it when the user asks what a thread did or found, or you need its result " +
  "to go on. It gives a short overview: the outcome, each step with its note, the result, the files changed and the " +
  "worktrees. State the outcome and the next move in plain words (make a plan when files must change); don't " +
  "make the user ask. Call read_thread with `step` (the step's number) only to see why one step went wrong. Call " +
  "summarize_thread, with in `focus` what you need, only when you need a digest the overview and a step can't " +
  "give: the thread's own model reads everything and writes a summary for you, but it sends the whole thread to " +
  "a model and costs money, so don't use it first. Never say you don't know what a thread did without reading it, " +
  "and don't guess from the report alone.";

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trimEnd()}…` : one;
};

const STATE: Record<string, string> = {
  done: "done",
  failed: "failed",
  disputed: "the check said it isn't done; waiting for the user to decide",
  waiting: "stopped to ask the user a question",
  running: "was running when the thread stopped",
  pending: "not run",
};

const stepLine = (s: PlanStep, i: number) => {
  const text = s.summary?.trim() || s.text;
  const note = s.note ? ` (${clip(s.note, NOTE_MAX)})` : "";
  return `${i + 1}. ${clip(text, NOTE_MAX)}: ${STATE[s.status] ?? s.status}${note}`;
};

const keepEnd = (text: string, max: number) =>
  text.length > max ? `…${text.slice(text.length - max + 1).trimStart()}` : text;

// The overview of a thread, never longer than OVERVIEW_MAX, in the order
// Thread, Outcome, steps, Result, Next, files, worktrees, and ending with a
// line that says how to get more. When it has to be short, notes of steps that
// went fine go first, then those steps, then the files and worktree lines; the
// step the thread is stuck on keeps its note.
export function overview(summary: string, parts: ThreadResultParts, files: string[], worktrees: string[]): string {
  const count = parts.steps.length;
  const more = count
    ? `More: read_thread with \`step\` (1 to ${count}) for one step in detail, or summarize_thread with a \`focus\` for a digest (it costs money).`
    : "More: summarize_thread with a `focus` for a digest (it costs money).";
  const top = `Thread: ${clip(summary, SUMMARY_MAX)}`;
  const tail = [
    `${parts.result.head}${parts.result.text ? ` ${keepEnd(parts.result.text, RESULT_MAX)}` : ""}`,
    parts.next,
  ].filter(Boolean);
  const build = (steps: string[], facts: string[]) =>
    [top, [parts.outcome, ...steps, ...tail].join("\n"), ...facts, more].join("\n\n");

  const lines = parts.steps.map((s) => ({
    head: clip(s.head, STEP_HEAD_MAX),
    note: clip(s.note, s.problem ? PROBLEM_NOTE_MAX : OTHER_NOTE_MAX),
    problem: s.problem,
  }));
  const mode: ("full" | "head" | "hidden")[] = lines.map(() => "full");
  const render = () => {
    const out = lines.flatMap((l, i) =>
      mode[i] === "hidden" ? [] : [mode[i] === "full" && l.note ? `${l.head} - ${l.note}` : l.head],
    );
    const hidden = mode.filter((m) => m === "hidden").length;
    return hidden ? [...out, `(${hidden} more ${hidden === 1 ? "step" : "steps"} not shown)`] : out;
  };
  const fits = (steps: string[], facts: string[] = []) => build(steps, facts).length <= OVERVIEW_MAX;
  for (const level of ["head", "hidden"] as const) {
    for (let i = count - 1; i >= 0 && !fits(render()); i--) {
      if (!lines[i].problem && mode[i] !== "hidden") mode[i] = level;
    }
  }
  const steps = render();

  const facts: string[] = [];
  const add = (block: string) => {
    if (fits(steps, [...facts, block])) facts.push(block);
  };
  if (files.length === 0) add("Files changed: none");
  else {
    for (let k = files.length; k >= 0; k--) {
      const block =
        k === 0
          ? `Files changed: ${files.length} (not listed)`
          : `Files changed:\n${files.slice(0, k).map((f) => `- ${f}`).join("\n")}${k < files.length ? `\n- …and ${files.length - k} more` : ""}`;
      if (fits(steps, [block])) {
        facts.push(block);
        break;
      }
    }
  }
  for (const line of worktrees) add(line);
  return build(steps, facts);
}

// The step number the model asked for (1-based, a number or digits), or null.
const stepNumber = (value: unknown, count: number): number | null => {
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= count ? n : null;
};

// One step in detail: its text and state, what the model said during it and
// what its commands and reads printed, cut at the start to STEP_DETAIL_MAX.
export function stepDetail(step: PlanStep, n: number, messages: ChatMessage[]): string {
  const mine = messages.filter((m) => m.planStep === step.id);
  const said = mine.filter((m) => m.role === "assistant" && m.content?.trim()).map((m) => m.content.trim());
  const printed = stepOutput(mine);
  const head = [
    `Step ${n}: ${step.text}`,
    `State: ${STATE[step.status] ?? step.status}${step.note ? `\nNote: ${step.note}` : ""}`,
  ].join("\n");
  const body = [
    `What the model said during the step:\n${said.length ? said.join("\n\n") : "(nothing)"}`,
    `What its commands and reads printed:\n${printed || "(nothing)"}`,
  ].join("\n\n");
  if (head.length + 2 + body.length <= STEP_DETAIL_MAX) return `${head}\n\n${body}`;
  const cut = "(the start was cut; this is the end)\n";
  const room = Math.max(0, STEP_DETAIL_MAX - head.length - 2 - cut.length);
  return `${head}\n\n${cut}${room ? body.slice(-room) : ""}`;
}

const WORDS: Record<string, string> = { done: "done", failed: "failed", unfinished: "not finished" };

// The threads this chat started, one per line, for the model to pick from.
const listText = (threads: PlanThread[]) =>
  threads.map((t) => `- ${t.sessionId}: ${t.summary}${t.status ? ` (${WORDS[t.status]})` : ""}`).join("\n");

// Which thread the model means: the id, a piece of the summary, or, with
// nothing said, the only one. With several, the model is asked to choose
// rather than left to a guess.
function pick(threads: PlanThread[], which: unknown): PlanThread {
  const wanted = typeof which === "string" ? which.trim() : "";
  if (!wanted) {
    if (threads.length === 1) return threads[0];
    throw new ToolError(`this chat started ${threads.length} threads; call summarize_thread again with one of these ids:\n${listText(threads)}`);
  }
  const byId = threads.find((t) => t.sessionId === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const byText = threads.filter((t) => t.summary.toLowerCase().includes(lower));
  if (byText.length === 1) return byText[0];
  throw new ToolError(
    `${byText.length > 1 ? "more than one thread matches" : "no thread matches"} ${JSON.stringify(wanted)}; use one of these ids:\n${listText(threads)}`,
  );
}

// The thread's record as plain text: what each side said, each tool call and
// what it returned, all of it. The thread's model read all of this while it
// worked, so it fits the model's window.
export function transcript(messages: ChatMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push(`User: ${m.content}`);
    else if (m.role === "assistant") {
      if (m.content?.trim()) out.push(`Assistant: ${m.content}`);
      for (const c of m.toolCalls ?? []) out.push(`Assistant called ${c.name}(${c.arguments})`);
    } else if (m.role === "tool") out.push(`Tool result:\n${m.content}`);
  }
  return out.join("\n\n");
}

export function summaryPrompt(messages: ChatMessage[], focus: string): string {
  return [
    "Below is the full record of a thread: a piece of work you did in a separate session for the chat that started it. " +
      "That chat can't see any of it. Write a summary for the chat: what was done and found, what was decided, " +
      "the files, paths, commands, branches and numbers it will need, and anything unfinished or waiting on the user. " +
      "End with a line starting \"Follow-up:\" listing what still has to happen after this work, by you or by the user " +
      "(for example restart or refresh the server, run a command, commit, approve something, answer a question), " +
      "or \"Follow-up: none\" if nothing does. " +
      "Plain text, as long as it needs to be and no longer. Reply with only the summary.",
    ...(focus ? [`What the chat most needs from it: ${focus}`] : []),
    `The record:\n\n${transcript(messages)}`,
  ].join("\n\n");
}

// Asks the model; the text, or an Error saying why not.
async function ask(connectorId: string, model: string, kind: any, api: any, prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  const answer: string[] = [];
  try {
    await streamChat(
      { connectorId, kind, api, model, messages: [{ role: "user", content: prompt }], purpose: { kind: "background" }, tools: [] },
      (d) => {
        if (d.content) answer.push(d.content);
      },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = answer.join("").trim();
  if (!text) throw new Error("the model answered with nothing");
  return text;
}

// The part both tools start from: the thread this chat means and how it ended,
// or the text to answer with when there is nothing to read.
type Opened = { answer: string } | { answer?: undefined; note: PlanThread; child: any; head: string };
async function openThread(chatId: string, which: unknown, verb: string): Promise<Opened> {
  const parent = await readSession(chatId);
  const threads: PlanThread[] = Array.isArray(parent?.threads) ? parent.threads : [];
  if (threads.length === 0) throw new ToolError(`this chat hasn't started any threads, so there is nothing to ${verb}`);
  const note = pick(threads, which);
  const child = await readSession(note.sessionId);
  if (!child) return { answer: `The thread "${note.summary}" was deleted, so there is nothing to ${verb}.` };
  const running = liveRun(note.sessionId);
  if (running && running.status !== "stopped") {
    return { answer: `The thread "${note.summary}" is still running. Ask again when it has finished; its note in the chat shows when.` };
  }
  const status = threadStatus(child);
  const steps: PlanStep[] = Array.isArray(child.plan) ? child.plan : [];
  const head = [
    `Thread: ${note.summary}`,
    `Outcome: ${WORDS[status] ?? status}`,
    ...(steps.length ? [`Steps:\n${steps.map(stepLine).join("\n")}`] : []),
  ].join("\n\n");
  return { note, child, head };
}

const readThread: ToolSpec = {
  name: "read_thread",
  group: "threads",
  label: "Read a thread",
  summary: "Read how a thread's plan went: outcome, steps, result, files.",
  definition: fn(
    "read_thread",
    "Read a thread this chat started: its outcome, its steps and how each ended (with their notes), the plan's " +
      "result, the files changed and where its work lives. With `step`, read that one step in detail instead: what " +
      "the model said during it and what its commands and reads printed (the end, if it is long). Use `step` only to " +
      "see why one step went wrong. Answers are cut to a few thousand characters and say how to get more. Nothing is " +
      "asked of a model. Works on a thread that has finished.",
    {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "The thread's id, or a few words of its summary. Optional when this chat started only one thread.",
        },
        step: {
          type: "integer",
          description: "A step's number, starting at 1, to read that step in detail instead of the overview. Optional.",
        },
      },
    },
  ),
  async run(ctx, args) {
    const opened = await openThread(ctx.chatId, args?.thread, "read");
    if (opened.answer !== undefined) return opened.answer;
    const { note, child } = opened;
    const messages: ChatMessage[] = Array.isArray(child.messages) ? child.messages : [];
    if (args?.step !== undefined && args.step !== null && args.step !== "") {
      const steps: PlanStep[] = Array.isArray(child.plan) ? child.plan : [];
      const n = stepNumber(args.step, steps.length);
      if (n === null) {
        throw new ToolError(
          steps.length
            ? `there is no step ${JSON.stringify(args.step)} in this thread; the steps are numbered 1 to ${steps.length}`
            : "this thread has no steps to read",
        );
      }
      return `Thread: ${note.summary}\n\n${stepDetail(steps[n - 1], n, messages)}`;
    }
    const files = filesChanged(messages.filter((m) => m.planStep));
    // A git read that fails leaves the worktree lines out; it never fails the answer.
    const worktrees = await worktreeStatuses(note.sessionId, messages).then(worktreeLines, () => [] as string[]);
    return overview(note.summary, threadResultParts({ plan: child.plan, messages }), files, worktrees);
  },
};

const summarizeThread: ToolSpec = {
  name: "summarize_thread",
  group: "threads",
  label: "Summarize a thread",
  summary: "Ask a thread's model for a summary of how its plan went. Costs money: it sends the whole thread to a model.",
  definition: fn(
    "summarize_thread",
    "Ask a thread this chat started for a summary: the thread's own model reads everything it did and writes what you " +
      "need to know. Works on a thread that has finished; a running one answers that it is still running.",
    {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "The thread's id, or a few words of its summary. Optional when this chat started only one thread.",
        },
        focus: {
          type: "string",
          description: 'What you need from it, for example "the branch name and what failed". Optional.',
        },
      },
    },
  ),
  async run(ctx, args) {
    const opened = await openThread(ctx.chatId, args?.thread, "summarize");
    if (opened.answer !== undefined) return opened.answer;
    const { note, child, head } = opened;

    const messages: ChatMessage[] = Array.isArray(child.messages) ? child.messages : [];
    const model = typeof child.model === "string" && child.model ? child.model : ctx.model;
    const connector = ctx.store.connectors?.find((c) => c.id === ctx.connectorId);
    const fallback = (why: string) =>
      [
        head,
        ...(note.report?.text ? [`Short report written when it ended: ${note.report.text}`] : []),
        `A summary couldn't be written (${why}); open the thread to read it.`,
      ].join("\n\n");
    if (!connector || !model) return fallback("the chat's model server isn't known");
    if (messages.length === 0) return `${head}\n\nThe thread has no messages.`;

    try {
      const focus = typeof args?.focus === "string" ? args.focus.trim() : "";
      const text = await ask(connector.id, model, connector.kind, connector.api, summaryPrompt(messages, focus));
      return `${head}\n\nSummary from the thread's model:\n${text}`;
    } catch (e) {
      return fallback(e instanceof Error ? e.message : String(e));
    }
  },
};

export const THREAD_TOOLS = [readThread, summarizeThread];
