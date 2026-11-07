// Side questions in a session's messages (see server/aside.ts). While a plan
// runs the plan owns the message list: every reply it makes writes back the
// whole list it has, which has no side question in it. So the run keeps the
// side questions apart, as groups placed by how many other messages came before
// them, and weaves them back into the session's messages after each change.
// Pure functions, no React.

import type { ChatMessage, PlanStep } from "./api.ts";
import { stepLine } from "./agent/plan.ts";

// Messages of side questions that came after `at` other messages.
export interface AsideGroup {
  at: number;
  messages: ChatMessage[];
}

export const isAside = (m: ChatMessage): boolean => m.aside === true;

// The messages the plan works with: no side question in them. The same array
// when there is none.
export function withoutAsides(messages: ChatMessage[]): ChatMessage[] {
  return messages.some(isAside) ? messages.filter((m) => !isAside(m)) : messages;
}

// The plan's own messages, and the side questions in them as groups, so that
// weaveAsides(plain, groups) puts them back where they were.
export function splitAsides(messages: ChatMessage[]): { plain: ChatMessage[]; groups: AsideGroup[] } {
  const plain: ChatMessage[] = [];
  const groups: AsideGroup[] = [];
  for (const m of messages) {
    if (!isAside(m)) {
      plain.push(m);
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.at === plain.length) last.messages.push(m);
    else groups.push({ at: plain.length, messages: [m] });
  }
  return { plain, groups };
}

// The session's messages: `plain` with each group before the message it was
// asked ahead of (at the end if the plan has fewer messages by now). Groups at
// the same place keep their order.
export function weaveAsides(plain: ChatMessage[], groups: AsideGroup[]): ChatMessage[] {
  if (!groups.length) return plain;
  const ordered = groups.map((g, i) => ({ g, i })).sort((a, b) => a.g.at - b.g.at || a.i - b.i).map((x) => x.g);
  const out: ChatMessage[] = [];
  let next = 0;
  for (let i = 0; i < plain.length; i++) {
    while (next < ordered.length && ordered[next].at <= i) out.push(...ordered[next++].messages);
    out.push(plain[i]);
  }
  while (next < ordered.length) out.push(...ordered[next++].messages);
  return out;
}

// How many of the first `n` messages are not side questions: a position in the
// session's messages as the plan counts it.
export const plainCount = (messages: ChatMessage[], n: number): number => messages.slice(0, n).filter((m) => !isAside(m)).length;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// The note that goes with a side question: what it is, that it can only read,
// and where the plan stands, as of now. A step starts with a fresh context, so
// the model has not seen the steps' own messages; this is what it knows of them.
export const ASIDE_NOTE =
  "This is a side question, asked while a plan is running in this chat. The plan goes on by itself and never sees this exchange. " +
  "Answer from what you know and what you can read with the tools. You can only read: you can't change files, run commands or " +
  "change the plan. If the user wants something changed, say they can tell the plan, or ask again when it has finished.";

export function asideNote(steps: PlanStep[] | null | undefined, latest?: string): string {
  const list = (steps ?? []).map((s, i) => {
    const state = s.status === "done" ? "done" : s.status;
    const note = s.note && s.status !== "done" ? ` (${clip(s.note.replace(/\s+/g, " ").trim(), 200)})` : "";
    return `${i + 1}. [${state}] ${clip(stepLine(s), 300)}${note}`;
  });
  const parts = [ASIDE_NOTE];
  if (list.length) parts.push(`The plan now:\n${list.join("\n")}`);
  const said = latest?.trim();
  if (said) parts.push(`The latest thing the running step said:\n${clip(said, 1500)}`);
  return parts.join("\n\n");
}
