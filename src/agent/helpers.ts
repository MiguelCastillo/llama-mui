// Pure helper functions extracted from Chat.tsx.

import { type ChatMessage, type ToolCall } from "../api.ts";

// Distributes token counts across messages, so the chat display shows roughly
// how many tokens each message used based on its share of total content length.
export function shareTokens(history: ChatMessage[], indexes: number[], tokens: number): ChatMessage[] {
  const chars = indexes.reduce((n, i) => n + history[i].content.length, 0) || 1;
  const next = [...history];
  for (const i of indexes) {
    const m = next[i];
    next[i] = { ...m, stats: { ms: m.stats?.ms ?? 0, tokens: Math.round((tokens * m.content.length) / chars) } };
  }
  return next;
}

// Same tool call, even if the model spaced its JSON differently. Used to
// detect repeated calls in a single reply (the third identical call is
// skipped to break loops).
export function callKey(call: ToolCall): string {
  try {
    return `${call.name} ${JSON.stringify(JSON.parse(call.arguments))}`;
  } catch {
    return `${call.name} ${call.arguments}`;
  }
}

// The first lines of a check command's output, for a step's note: past its
// "$ command" line, without the "[exit code N]" line.
export function commandSummary(output: string): string {
  const lines = output.split("\n").slice(1, -1).filter((l) => l.trim());
  const text = lines.slice(0, 2).join(" ").trim() || "(no output)";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// The INTERRUPTED constant, extracted so failureLine is pure.
export const INTERRUPTED = "interrupted";

// The failure to show for a session. A run saves "interrupted" in its session
// for as long as a request is in flight (so a reload mid-reply doesn't look
// like a finished one); while that run is still going, the reply is streaming
// fine and the mark is not a failure. Any other failure, and "interrupted" in a
// session with no live run, is real.
export function shownFailure(failed: string | null | undefined, running: boolean): string | null {
  if (!failed) return null;
  return running && failed === INTERRUPTED ? null : failed;
}

const MESSAGE_CUT = 160;

// What happened to a failed reply, in the user's terms. `who` is the
// connector's name or kind. Our server answers 502 when it can't reach the
// llama server; a TypeError means the request never got an answer at all. A
// 4xx like "Error: POST /v1/messages: 400 <message>" was an answer: say who
// gave it and what it said, cut short (the full error is in the tooltip).
export function failureLine(failed: string, who = "the llama server"): string {
  const name = who.trim() || "the llama server";
  const sentence = name.charAt(0).toUpperCase() + name.slice(1);
  if (failed === INTERRUPTED) return "The reply was cut off.";
  if (failed.startsWith("TypeError") || failed.includes(": 502 ")) return `Couldn't reach ${name}.`;
  const rejected = /^(?:Error: )?POST \S+: 4\d\d\s+([\s\S]*)$/.exec(failed);
  if (rejected) {
    const message = rejected[1].replace(/\s+/g, " ").trim();
    if (message) {
      const cut = message.length > MESSAGE_CUT ? `${message.slice(0, MESSAGE_CUT).trimEnd()}…` : message;
      return `${sentence} rejected the request: ${cut}`;
    }
  }
  return `${sentence} returned an error.`;
}
