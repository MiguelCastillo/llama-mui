// What the one-line summary of one steps row says (see StepsRow): how many
// steps its rounds had. A step is a thinking block or a tool call that is
// shown as a row; the note tools show as boxes under the reply, so they don't
// count. The reply's total time shows in the footer, not here. While a reply
// runs, the one live line at its bottom says what it is doing (see liveLine.ts).

import type { ChatMessage } from "./api.ts";
import { shownCalls } from "./agent/replyNotes.ts";

export interface StepSummary {
  // Thinking blocks plus shown tool calls of all the rounds in the row.
  count: number;
}

// `group` is the rounds that share one row, in order; each round is one
// assistant message (a row of a single round is a group of one).
export function stepSummary(group: ChatMessage[]): StepSummary {
  let count = 0;
  for (const part of group) {
    if (part.role !== "assistant") continue;
    count += (part.reasoning ? 1 : 0) + shownCalls(part.toolCalls).length;
  }
  return { count };
}
