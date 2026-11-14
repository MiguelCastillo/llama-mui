// What the one live line says while a reply is still running. It says what the
// model is doing now, never something already drawn above it in the chat:
//   - a tool call is running: "Running" and that call's title (see
//     toolCallTitle.ts), or "Working…" when Show steps is off, since a call is
//     a step;
//   - the newest round is writing text: "Writing…";
//   - otherwise: "Thinking…", or on a connection whose reasoning is a summary
//     (Claude), the last line of the newest round's thinking summary. Raw
//     thoughts are never shown there.
// `writingAnswer` is true while the newest round has text and no tool calls
// yet (the calls arrive when its stream ends, so it may still be the text
// before them); the caller uses it to show the streaming speed.

import type { ChatMessage } from "./api.ts";
import { shownCalls } from "./agent/replyNotes.ts";
import { toolCallTitle } from "./toolCallTitle.ts";

export const THINKING_TEXT = "Thinking…";
export const WRITING_TEXT = "Writing…";
export const WORKING_TEXT = "Working…";

export interface LiveLine {
  text: string;
  writingAnswer: boolean;
}

export interface LiveLineOptions {
  // The connection's (see connections/types.ts): reasoning is a readable summary.
  reasoningIsSummary?: boolean;
  // Show steps is on: a running call may be named.
  showCalls?: boolean;
  // Whether a call has its result yet.
  hasResult?: (callId: string) => boolean;
}

// `parts` are the messages of one reply; only assistant messages are rounds.
export function liveLine(parts: ChatMessage[], opts: LiveLineOptions = {}): LiveLine {
  const rounds = parts.filter((m) => m.role === "assistant");
  const newest = rounds[rounds.length - 1];
  const calls = shownCalls(newest?.toolCalls);
  const writingAnswer = !!newest && !!newest.content.trim() && calls.length === 0;
  const running = calls.find((c) => !opts.hasResult?.(c.id));
  if (running) return { text: opts.showCalls ? `Running ${toolCallTitle(running)}` : WORKING_TEXT, writingAnswer };
  if (writingAnswer) return { text: WRITING_TEXT, writingAnswer };
  if (opts.reasoningIsSummary && newest?.reasoning) {
    const last = newest.reasoning.trim().split("\n").filter((l) => l.trim()).pop();
    if (last) return { text: last.replace(/^[*#\s]+|[*\s]+$/g, ""), writingAnswer };
  }
  return { text: THINKING_TEXT, writingAnswer };
}
