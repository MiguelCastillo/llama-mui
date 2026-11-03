import type { ChatMessage } from "./api.ts";

export const UNFINISHED_CALL =
  "This call did not run: it was cut off before it finished (the page was reloaded while it waited).";

// A tool call that never got a result (the page reloaded or the server
// restarted while it waited for approval or ran) makes every later request
// fail: both APIs want each call answered right after its message. Returns
// the messages with a result added for every such call, placed after the
// assistant message's existing results. Calls that have a result are left
// alone, so running it again changes nothing. Returns the same array when
// there's nothing to close.
export function closeOpenToolCalls(messages: ChatMessage[]): ChatMessage[] {
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
        content: UNFINISHED_CALL,
        toolCallId: c.id,
        stats: { ms: 0, tokens: 0 },
        ...(m.planStep ? { planStep: m.planStep } : {}),
      });
    }
    i = end - 1;
  }
  return out ?? messages;
}
