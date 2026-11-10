// Which rounds of a reply share one steps row (see StepsRow). A reply is made
// of rounds (one assistant message each). Every round that calls tools puts its
// steps under the note it starts with (the model's short text before its
// calls). The model may skip the note, though, and then two rows would sit side
// by side with nothing between them. So a round with no note text joins the
// row of the round before it, as long as that round also had steps to show
// under a note. Whether the model meant a new round or more steps of the same
// one is not visible, on purpose.

import type { ChatMessage } from "./api.ts";
import { shownCalls } from "./agent/replyNotes.ts";

export interface RoundGroup {
  // The round: one assistant message of the reply.
  round: ChatMessage;
  // True when this round's steps go into the previous round's row, so it draws
  // no row of its own.
  joinsPrevious: boolean;
}

// `parts` are the messages of one reply. Only assistant messages are rounds;
// anything else (a tool result) is skipped. A round joins the previous one when
// it has steps (a thinking block or shown tool calls), has no note text (empty
// or only spaces) and the previous round called shown tools. A round with no
// steps never joins. A leading round with no note has nothing before it, so it
// starts the first row. A round with no tool calls is not joined by the round
// after it, since its row sits above its own text.
export function groupRounds(parts: ChatMessage[]): RoundGroup[] {
  const groups: RoundGroup[] = [];
  let prevHadCalls = false;
  for (const round of parts) {
    if (round.role !== "assistant") continue;
    const hasCalls = shownCalls(round.toolCalls).length > 0;
    const hasSteps = hasCalls || !!round.reasoning;
    groups.push({ round, joinsPrevious: hasSteps && prevHadCalls && !round.content.trim() });
    prevHadCalls = hasCalls;
  }
  return groups;
}
