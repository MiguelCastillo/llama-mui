// Compaction: when a chat is nearly full, the model writes a summary of the
// conversation so far, and from then on it is sent that summary instead of the
// older messages. Nothing is deleted: every message stays in the saved chat and
// on screen, and the chat's history start (Session.contextStart) moves forward
// to the message that asked for the summary, which a divider marks.
//
// The summary is asked for as an ordinary message, through the same request as
// any reply (same system prompt, same tools, same old tool results left out),
// so the server's memory of the last request is reused instead of the whole
// conversation being read again. Tools stay in the request but may not run.
//
// Fixed behavior, not a setting. The code that runs it is in server/runners.ts
// (when) and src/runnerReply.ts (how); docs/guide.md has the details under Compaction.
// No React in this file.

import type { ChatMessage, Model, Usage } from "./api.ts";
import { COMPACT_AT, contextShare } from "./contextShare.ts";

// The message that asks for the summary is the text of
// prompts/compaction-instructions.md, read by the server (server/compactInstruction.ts).
// The model will see only that summary and what comes after it, so the
// wording has to ask for what the next message may depend on.

// All the user is told about a compaction that didn't work. One that did shows as
// a divider ("Session compacted").
export const COMPACT_FAILED = "Session compaction failed.";

// What the model is told when it tries a tool while writing the summary.
export const COMPACT_REFUSAL = "Tools aren't available while you write the summary. Write it from what you already know.";

// How many times in a row a failed compaction is tried again, one try after each
// reply, before it waits for a reply that gets the chat under the threshold or for
// the Compact session button. A guess to tune.
export const MAX_COMPACT_TRIES = 2;

// How full the chat's context window is, from the usage of the last request.
export function chatShare(usage: Usage | null | undefined, models: Model[], model: string): number {
  return contextShare(usage, models.find((m) => m.id === model)?.contextSize);
}

// A finished reply left the chat past the threshold: compact it now.
export const needsCompaction = (usage: Usage | null | undefined, models: Model[], model: string): boolean =>
  chatShare(usage, models, model) >= COMPACT_AT;

// The chat has no room left for the next message: compact before sending it.
export const mustCompactFirst = (usage: Usage | null | undefined, models: Model[], model: string): boolean =>
  chatShare(usage, models, model) >= 1;

// Where the compaction request is in the messages, and its summary: the reply
// that follows it. null for a request that got no usable summary.
export function summaryOf(messages: ChatMessage[]): { at: number; summary: string } | null {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].compaction) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const reply = messages.slice(at + 1).filter((m) => m.role === "assistant" && m.compaction && m.content.trim());
  const summary = reply.at(-1)?.content.trim();
  return summary ? { at, summary } : null;
}
