// Calls a reply repeats after the model was made to forget them: the tool calls
// in the messages a turn wrote that are the same as a call made before the
// chat's history start (see compact.ts), the same tool with the same arguments,
// compared by meaning and not spacing. A compaction summarizes what happened, so
// a repeated call is work the summary didn't carry forward. The usage log keeps
// the count per turn (`forgottenRereads`), which says whether compacting is too
// eager. No React in this file.

import type { ChatMessage } from "./api.ts";
import { sameArguments } from "./toolResults.ts";

type Call = { name: string; arguments: string };

const callsIn = (messages: ChatMessage[]): Call[] => messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []));

// How many of the calls in `written` (what the turn wrote) repeat one in `earlier`
// (the messages before the history start).
export function repeatedCalls(written: ChatMessage[], earlier: ChatMessage[]): number {
  const before = callsIn(earlier);
  if (!before.length) return 0;
  return callsIn(written).filter((c) => before.some((o) => o.name === c.name && sameArguments(o.arguments ?? "", c.arguments ?? ""))).length;
}
