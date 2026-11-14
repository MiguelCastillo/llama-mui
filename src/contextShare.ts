// How full the model's context window is, shared by the page (the meter under
// the Send button) and the server (which decides when to compact a chat).
// No React in this file.

import type { Usage } from "./api.ts";

// The share of the window at which the meter turns orange.
export const CONTEXT_WARN_AT = 0.8;
// The share at which a chat is compacted (see compact.ts). Lower than the
// meter's warning on purpose: on a 1M-token window the whole conversation is
// re-read by every request, so staying near the limit is expensive. A decision
// of 2026-11-14, to tune.
export const COMPACT_AT = 0.6;
// The share at which the meter turns red.
export const CONTEXT_FULL_AT = 0.95;

// How much of the model's context the conversation fills. Past the limit
// llama.cpp drops the oldest tokens, so the model starts forgetting the
// beginning of the chat. 0 when either number is unknown.
export const contextShare = (usage: Usage | null | undefined, contextSize?: number) =>
  usage && contextSize ? usage.contextTokens / contextSize : 0;
