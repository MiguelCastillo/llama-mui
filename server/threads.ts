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
import { finalMessage, threadStatus } from "../src/planThread.ts";
import { liveRun } from "./runHub.ts";
import { readSession } from "./sessionFile.ts";
import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

// How long the thread's model has to write the summary.
export const SUMMARY_TIMEOUT_MS = 180_000;
const NOTE_MAX = 300;

export const threadInstructions =
  "When a plan ran in a thread, the chat gets a note with a short report, and a Chat update lists how each thread " +
  "ended. If that isn't enough (the user asks what the thread did or found, or you need its result to go on), call " +
  "read_thread: it gives the steps and the thread's own final message. Only if that still isn't enough, call " +
  "summarize_thread: the thread's own model reads everything and writes a summary for you (say in `focus` what you " +
  "need), but it sends the whole thread to a model and costs money, so don't use it first. Don't guess what a " +
  "thread did from its report alone.";

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
      { connectorId, kind, api, model, messages: [{ role: "user", content: prompt }], think: false, tools: [] },
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
  summary: "Read a thread's steps and its final message.",
  definition: fn(
    "read_thread",
    "Read a thread this chat started: its steps and how each ended, and the thread's own final message, whole. " +
      "Nothing is asked of a model. Works on a thread that has finished.",
    {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "The thread's id, or a few words of its summary. Optional when this chat started only one thread.",
        },
      },
    },
  ),
  async run(ctx, args) {
    const opened = await openThread(ctx.chatId, args?.thread, "read");
    if (opened.answer !== undefined) return opened.answer;
    const text = finalMessage(opened.child.messages);
    return `${opened.head}\n\n${text ? `The thread's final message:\n${text}` : "The thread has no final message."}`;
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
