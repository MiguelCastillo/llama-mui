// Pure helper functions extracted from Chat.tsx.

import { type ChatMessage, type ToolCall } from "../api";

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

// What happened to a failed reply, in the user's terms. Our server answers
// 502 when it can't reach the llama server; a TypeError means the request
// never got an answer at all.
export function failureLine(failed: string): string {
  if (failed === INTERRUPTED) return "The reply was cut off.";
  if (failed.startsWith("TypeError") || failed.includes(": 502 ")) return "Couldn't reach the llama server.";
  return "The llama server returned an error.";
}
