import type { ChatMessage, ToolCall } from "./api.ts";

// For a call that was still waiting for the user's answer: it never started.
export const UNFINISHED_CALL =
  "This call did not run: it was cut off before it finished (the page was reloaded while it waited).";

// For any other open call: it may have started, so it may have done some or
// all of its work.
export const MAY_HAVE_RUN_CALL =
  "This call may not have finished: the app stopped while it was in progress, and it may have done some or all of its work. Check the current state (files, git status, output) before repeating it.";

// For an open call of a read-only tool (search, fetch, read): it did not
// finish, and running it again changes nothing.
export const SAFE_TO_REPEAT_CALL = "This call did not complete: it was cut off before it finished. It only reads, so it is safe to repeat.";

// A chat that records the start of changing calls has at least one call with
// the mark. Only then does a missing mark mean "never started"; in a chat
// without any, the mark may simply not have existed yet.
function hasMarks(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.toolCalls?.some((c) => c.started === true));
}

// The one call a run was waiting on when it stopped with a question pending.
// Calls run one after another, so it is the first call without a result in
// the last assistant message that has any; the calls after it never started
// either, but are not named here. Empty when there is no such call.
export function callsWaitingForAnswer(messages: ChatMessage[]): string[] {
  const answered = new Set<string>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) answered.add(m.toolCallId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const open = messages[i].toolCalls?.find((c) => !answered.has(c.id));
    if (messages[i].role === "assistant" && open) return [open.id];
  }
  return [];
}

// A tool call that never got a result (the page reloaded or the server
// restarted while it waited for approval or ran) makes every later request
// fail: both APIs want each call answered right after its message. Returns
// the messages with a result added for every such call, placed after the
// assistant message's existing results. Which text a call gets:
//  - it has the started mark: "may have run, check first";
//  - its tool only reads (`effect` says "none"): "did not complete, safe to repeat";
//  - the chat has marks, so no mark means it never started: "did not run";
//  - an old chat without any mark: a call whose id is in `waiting` was still
//    waiting for the user's answer and gets "did not run"; every other one may
//    have started and gets "may not have finished".
// `effect` tells a call's effect when the caller knows the tools (the server
// does, the page does not); without it the first rule and the last two apply.
// Calls that have a result are left alone, so running it again changes
// nothing. Returns the same array when there's nothing to close.
export function closeOpenToolCalls(
  messages: ChatMessage[],
  waiting: Iterable<string> = [],
  effect?: (call: ToolCall) => "none" | "change",
): ChatMessage[] {
  const notStarted = new Set(waiting);
  const marked = hasMarks(messages);
  const textFor = (c: ToolCall): string => {
    if (c.started) return MAY_HAVE_RUN_CALL;
    if (effect && effect(c) === "none") return SAFE_TO_REPEAT_CALL;
    if (marked || notStarted.has(c.id)) return UNFINISHED_CALL;
    return MAY_HAVE_RUN_CALL;
  };
  const answered = new Set<string>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) answered.add(m.toolCallId);

  let out: ChatMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out?.push(m);
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;

    // Keep the message's own results next to it, then add what's missing.
    let end = i + 1;
    while (end < messages.length && messages[end].role === "tool") end++;
    const missing = m.toolCalls.filter((c) => !answered.has(c.id));
    if (!missing.length) continue;

    out ??= messages.slice(0, i + 1);
    for (let j = i + 1; j < end; j++) out.push(messages[j]);
    for (const c of missing) {
      answered.add(c.id);
      out.push({
        role: "tool",
        content: textFor(c),
        toolCallId: c.id,
        stats: { ms: 0, tokens: 0 },
        ...(m.planStep ? { planStep: m.planStep } : {}),
      });
    }
    i = end - 1;
  }
  return out ?? messages;
}
