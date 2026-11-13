// Old tool results, left out of what the model is sent. Every request carries
// the whole chat since Clear context, and in a working chat most of that is
// tool results (whole files, command output) the model needed once, while it
// acted on them. Its reply already says what mattered.
//
// The rule, the same for every connection, once the chat is past
// CLEAR_AFTER_TOKENS: the tool results of replies before the last one may be
// replaced by a one-line stub saying what each was and to call the tool again
// if needed (so the model looks again instead of guessing). The last reply's
// results stay whole, for a follow-up like "fix that error", and so do the
// current reply's while it works. The saved chat is never changed; only what
// a request carries.
//
// When the cut moves, for the cache: a cache (Anthropic's prompt cache,
// llama.cpp's) is reused only up to the first thing that differs from the
// last request, and everything after it is written or processed again. So
// the cut is decided once per turn and saved with the chat (CutState), and
// it moves only when that costs nothing extra: when the chat has been idle
// IDLE_MS (Anthropic's cache has gone, so the history is written again
// anyway, and shorter), or when enough has piled up behind it
// (WARM_MOVE_TOKENS) that the chat needs the room. Otherwise the requests go
// on leaving out what they left out before, and start exactly as the last
// one did. Replayed over the saved chats, moving it at every user message
// cost more than not clearing at all when the user answered within five
// minutes (each move rewrote the whole history while the cache was warm).
//
// What counts is weight, not the number of calls: a stub in place of a short
// result saves nothing. One reply whose results are heavy on their own also
// has its oldest results stubbed: when the ones kept pass REPLY_HIGH_TOKENS,
// the oldest go until those kept are under REPLY_LOW_TOKENS. The gap between
// the two means the cut moves rarely, for the same reason. On llama.cpp a
// result under SMALL_RESULT_CHARS is never stubbed (Anthropic clears by count
// and can't tell; there a stub costs about what a short result does).
//
// Claude: Anthropic does the clearing on its side (clear_tool_uses, see
// connections/anthropic.ts), told how many to keep: the rest after
// requestCount.
// llama.cpp: clearOldToolResults below, when the request is built.

export const CLEAR_AFTER_TOKENS = 30_000;
// Anthropic's prompt cache lives five minutes from the request that last used it.
export const IDLE_MS = 5 * 60_000;
export const WARM_MOVE_TOKENS = 50_000;
export const REPLY_HIGH_TOKENS = 30_000;
export const REPLY_LOW_TOKENS = 10_000;
export const SMALL_RESULT_CHARS = 1_000;

type Message = { role: string; content: string; toolCalls?: { id: string; name: string; arguments?: string }[]; toolCallId?: string };

const tokensOf = (chars: number) => Math.ceil(chars / 4);

// Inside one reply: how many of its results, oldest first, are left out,
// given their sizes in characters. Replayed from the reply's first result, so
// the same results always give the same answer, and a new result only moves
// it when the kept ones pass REPLY_HIGH_TOKENS. The newest is always kept.
export function cutWithinReply(sizes: number[]): number {
  let cut = 0;
  let kept = 0;
  sizes.forEach((size, i) => {
    kept += tokensOf(size);
    if (kept <= REPLY_HIGH_TOKENS) return;
    while (cut < i && kept > REPLY_LOW_TOKENS) kept -= tokensOf(sizes[cut++]);
  });
  return cut;
}

// About four characters to a token, which is close enough to decide when to start.
const roughTokens = (messages: { content?: string }[]) => Math.ceil(messages.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4);

// Whether a request is long enough to leave old results out at all. Decided
// here for every connection, from the history as sent (which only grows until
// Clear context), so it starts once and stays on.
export const isLong = (messages: { content?: string }[], afterTokens = CLEAR_AFTER_TOKENS) => roughTokens(messages) > afterTokens;

const resultIndices = (messages: Message[]) => messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
const userIndices = (messages: Message[]) => messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
const resultsBefore = (messages: Message[], index: number) => resultIndices(messages).filter((i) => i < index).length;

// How many of the oldest tool results the replies before the last one hold:
// what the cut would leave out if it moved now.
export function crossReplyCount(messages: Message[]): number {
  if (!isLong(messages)) return 0;
  const users = userIndices(messages);
  return users.length >= 2 ? resultsBefore(messages, users[users.length - 2]) : 0;
}

// For a turn whose own results are heavy: everything before the turn, and its
// oldest results by weight (cutWithinReply). 0 when the turn isn't heavy.
export function heavyCount(messages: Message[]): number {
  if (!isLong(messages)) return 0;
  const users = userIndices(messages);
  const from = users.length ? users[users.length - 1] : -1;
  const sizes = messages.slice(from + 1).flatMap((m) => (m.role === "tool" ? [m.content.length] : []));
  const cut = cutWithinReply(sizes);
  return cut ? resultsBefore(messages, from + 1) + cut : 0;
}

// Where the cut stood after a chat's last turn, saved with the chat: how many
// of the oldest tool results were left out, counted from `from` (the chat's
// contextStart then; a Clear context starts afresh), and when its last request
// went out.
export type CutState = { from: number; count: number; lastRequestAt: number };

// At the start of a turn: how many of the oldest results its requests leave
// out. `messages` is the history since `from`, the new message included.
export function turnCount(messages: Message[], saved: CutState | undefined, from: number, now: number): number {
  const proposal = crossReplyCount(messages);
  const stored = saved && saved.from === from ? saved.count : undefined;
  if (stored === undefined) return proposal;
  if (proposal <= stored) return stored;
  const results = resultIndices(messages);
  const pending = results.slice(stored, proposal).reduce((n, i) => n + tokensOf(messages[i].content.length), 0);
  return now - saved!.lastRequestAt >= IDLE_MS || pending >= WARM_MOVE_TOKENS ? proposal : stored;
}

// How many of the oldest results one request leaves out: the turn's count
// (turnCount), or more when the turn is heavy on its own. Without a turn's
// count (a plan step, a side question, a page's own request), it is decided
// from the history alone, as if the cut moved at every user message.
export function requestCount(messages: Message[], turn?: number): number {
  if (turn === undefined) return Math.max(crossReplyCount(messages), heavyCount(messages));
  return Math.max(turn, heavyCount(messages));
}

export const toolResultStub = (name: string, chars: number) =>
  `[Removed to save space: the result of ${name} (${chars} characters). Call the tool again if you need it.]`;

// The indices of the `count` oldest tool results: the ones a request leaves
// out, and the set Anthropic clears when told to keep the rest.
export const oldResults = (messages: Message[], count: number): number[] => resultIndices(messages).slice(0, count);
export const resultCount = (messages: Message[]) => resultIndices(messages).length;

// What leaving them out did to one request, for the usage log: how many
// results and roughly how many tokens were left out (estimated from their
// length; Anthropic reports its own count), and the calls they came from,
// so a later call that asks again can be counted as a re-read.
export type Cleared = { results: number; tokens: number; calls: { name: string; arguments: string }[] };

export function clearedBy(messages: Message[], count: number, { skipSmall }: { skipSmall: boolean }): Cleared {
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const m of messages) for (const c of m.toolCalls ?? []) calls.set(c.id, { name: c.name, arguments: c.arguments ?? "" });
  const out: Cleared = { results: 0, tokens: 0, calls: [] };
  for (const i of oldResults(messages, count)) {
    const m = messages[i];
    if (skipSmall && m.content.length < SMALL_RESULT_CHARS) continue;
    const call = calls.get(m.toolCallId ?? "") ?? { name: "a tool", arguments: "" };
    out.results++;
    out.tokens += Math.max(0, tokensOf(m.content.length) - tokensOf(toolResultStub(call.name, m.content.length).length));
    out.calls.push(call);
  }
  return out;
}

// Arguments compared by meaning, not text: a model writes the same call with
// different spacing or key order.
function sameArguments(a: string, b: string): boolean {
  const norm = (t: string) => {
    try {
      const sort = (v: unknown): unknown =>
        Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v;
      return JSON.stringify(sort(JSON.parse(t || "{}")));
    } catch {
      return t.trim();
    }
  };
  return norm(a) === norm(b);
}

// How many of a reply's tool calls ask again for a result that was left out:
// the same tool with the same arguments. The cost side of leaving them out.
export const rereads = (cleared: Cleared, replyCalls: { name: string; arguments: string }[]) =>
  replyCalls.filter((c) => cleared.calls.some((o) => o.name === c.name && sameArguments(o.arguments, c.arguments))).length;

// The messages with the `count` oldest tool results replaced by a stub.
// Short ones stay.
export function clearOldToolResults<M extends Message>(messages: M[], count: number): M[] {
  const old = new Set(oldResults(messages, count));
  if (!old.size) return messages;
  const names = new Map<string, string>();
  for (const m of messages) for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
  return messages.map((m, i) => {
    if (!old.has(i)) return m;
    if (m.content.length < SMALL_RESULT_CHARS) return m;
    return { ...m, content: toolResultStub(names.get(m.toolCallId ?? "") ?? "a tool", m.content.length) };
  });
}
