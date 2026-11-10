// What the one live line says while a reply is still running. A reply is made
// of rounds (one assistant message each). The line shows the latest note: the
// short text the model wrote before its tool calls. Until there is one, it says
// "Thinking…". When the newest round is already writing the final answer (text
// and no tool calls) the answer streams as normal text and the line is not
// shown, so `writingAnswer` tells the caller to leave it out.

import type { ChatMessage } from "./api.ts";
import { shownCalls } from "./agent/replyNotes.ts";

export const THINKING_TEXT = "Thinking…";

export interface LiveLine {
  // The latest note, trimmed, or "Thinking…" when there is none.
  text: string;
  // True when the newest round has text and no tool calls: it is the answer.
  writingAnswer: boolean;
}

// `parts` are the messages of one reply; only assistant messages are rounds.
// The note is searched from the newest round backwards, so a newest round that
// has no note yet (it is only thinking, or has just started its calls) keeps
// showing the note before it.
export function liveLine(parts: ChatMessage[]): LiveLine {
  const rounds = parts.filter((m) => m.role === "assistant");
  const newest = rounds[rounds.length - 1];
  const writingAnswer = !!newest && !!newest.content.trim() && shownCalls(newest.toolCalls).length === 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const text = rounds[i].content.trim();
    if (text && shownCalls(rounds[i].toolCalls).length > 0) return { text, writingAnswer };
  }
  return { text: THINKING_TEXT, writingAnswer };
}
