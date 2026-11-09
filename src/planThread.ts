// Plan threads: a plan that has not started runs in its own nested session, so
// the session it was written in stays free. Pure: no React, no network.
//
// - planRequestFor: the user's request that led to a plan (the child's first
//   message, and what every step is told the task is).
// - isFreshPlan: whether a plan has not started, so it may move.
// - planToThread: builds the child session and the parent without the plan.
// - threadStatus / threadLabel: what the parent's note says about the thread,
//   from the child's saved plan.
// - noteView / applyThreadEvent: what a note shows (spinner, outcome, report),
//   and a `thread` event from the server applied to the notes.
// - worktreeLine / worktreeLines: where a thread's work lives, in words.
import type { ChatMessage, PlanStep, PlanThread, Session, ThreadOutcome, WorktreeStatus } from "./api.ts";
import { stepLine } from "./agent/plan.ts";
import type { Ask } from "./runnerTypes.ts";
import { nestedSessionFrom } from "./sessionTree.ts";
import { newId } from "./uuid.ts";

// The message that asked for a plan: the last one the user sent (not a step's)
// before the update_plan call that wrote it (the call whose id is `anchor`),
// or before "at:N" for a clone or a compacted plan. With no anchor that
// matches, the whole chat counts. Undefined when there is no such message.
export function planRequestFor(messages: ChatMessage[], anchor: string | null | undefined): string | undefined {
  const call = messages.findIndex((m) => m.toolCalls?.some((c) => c.id === anchor));
  const end = call >= 0 ? call : anchor?.startsWith("at:") ? Number(anchor.slice(3)) : messages.length;
  return [...messages.slice(0, end)].reverse().find((m) => m.role === "user" && !m.planStep)?.content;
}

// A plan that has not started: it has steps, every step is pending, and no
// message belongs to a step's turn. Only such a plan moves to a thread; one
// that has run, even a little, stays where it is.
export function isFreshPlan(steps: PlanStep[] | null | undefined, messages: ChatMessage[]): boolean {
  return !!steps && steps.length > 0 && steps.every((s) => s.status === "pending") && !messages.some((m) => m.planStep);
}

const TITLE_MAX = 80;

// Moves the parent's fresh plan into a new nested session with id `childId`.
// The child starts from the parent's model and folders (nestedSessionFrom),
// not its history: its first message is the request that led to the plan, and
// it holds a copy of the plan, its context and summary, anchored after that
// message. planMovedIn tells the child that Run there runs the plan in place
// instead of moving it again. It is titled from the plan's summary (or its
// first step) until the model names it.
// The parent comes back without the plan and with a note (threads) where the
// plan was. Plan and note share a planId (the plan's own if it has one, else
// `planId`, a new one by default), so the note can point at the plan inside
// the thread. Returns null when the plan is not fresh. Neither input changes.
export function planToThread(
  parent: Session,
  childId: string,
  planId: string = parent.planId ?? newId(),
): { parent: Session; child: Session } | null {
  if (!parent.plan || !isFreshPlan(parent.plan, parent.messages)) return null;

  const request =
    planRequestFor(parent.messages, parent.planAnchor) ?? parent.planSummary ?? "Run the plan below.";
  const summary = parent.planSummary?.trim() || stepLine(parent.plan[0]);
  const title = summary.slice(0, TITLE_MAX);

  const child: Session = {
    ...nestedSessionFrom(parent, childId),
    title,
    titleHint: title,
    messages: [{ role: "user", content: request }],
    plan: parent.plan.map((s) => ({ ...s })),
    planContext: parent.planContext ?? null,
    planSummary: parent.planSummary ?? null,
    planAnchor: "at:1",
    planId,
    planMovedIn: true,
  };

  const moved: Session = {
    ...parent,
    plan: null,
    planProposal: null,
    planContext: null,
    planSummary: null,
    planAnchor: null,
    planId: null,
    threads: [...(parent.threads ?? []), { sessionId: childId, summary, anchor: parent.planAnchor ?? null, planId }],
  };
  return { parent: moved, child };
}

// How a thread stands, from the child's saved state. "missing": the child
// can't be found (null). "done": all its steps are done. "failed": a step
// failed or is disputed. Anything else is "unfinished": a plan that is not
// finished and has no run was stopped. While a run has it the child is
// running, and the caller shows that (no status) rather than calling this.
export type ThreadStatus = "missing" | "done" | "failed" | "unfinished";

export function threadStatus(child: Pick<Session, "plan"> | null): ThreadStatus {
  if (!child) return "missing";
  const steps = child.plan;
  if (!steps || steps.length === 0) return "unfinished";
  if (steps.some((s) => s.status === "failed" || s.status === "disputed")) return "failed";
  if (steps.every((s) => s.status === "done")) return "done";
  return "unfinished";
}

// What a note shows. `seen` is what the page found out about the thread
// itself: "running" (it has a run), or its saved state (threadStatus; "missing"
// when it was deleted); undefined while that is being read.
//  - A run going: a spinner, and no outcome, whatever the last run left.
//  - A deleted thread: says so, whatever the note remembers.
//  - Otherwise the note's own status and report, written by the server when the
//    run ended (server/threadReport.ts). A note made before they existed has
//    none, so it takes the thread's saved state, and has no report.
export interface NoteView {
  running: boolean;
  status: ThreadStatus | undefined;
  report?: string;
}

export function noteView(note: PlanThread, seen: ThreadStatus | "running" | undefined): NoteView {
  if (seen === "running") return { running: true, status: undefined };
  if (seen === "missing") return { running: false, status: "missing" };
  if (note.status) return { running: false, status: note.status, ...(note.report ? { report: note.report.text } : {}) };
  return { running: false, status: seen };
}

// The server's `thread` event: the parent's note for `sessionId` got a new
// status, and a report (null while the report is still being written).
export interface ThreadEvent {
  sessionId: string;
  planId?: string;
  status: ThreadOutcome;
  report: PlanThread["report"] | null;
}

// The notes with that event applied; the same array when no note is about
// that thread (or, with a planId, that plan), so the page changes nothing.
export function applyThreadEvent(threads: PlanThread[], e: ThreadEvent): PlanThread[] {
  const hit = (t: PlanThread) => t.sessionId === e.sessionId && (!e.planId || !t.planId || t.planId === e.planId);
  if (!threads.some(hit)) return threads;
  return threads.map((t) => {
    if (!hit(t)) return t;
    const { report: _old, ...rest } = t;
    return { ...rest, status: e.status, ...(e.report ? { report: e.report } : {}) };
  });
}

// What the model of the chat that started the threads is told about them, so it
// knows how each plan went: one line per thread whose run has ended, with the
// report under it. Empty when none has ended (a thread still running, or with
// no outcome yet, is left out so the text only changes when there is news).
const OUTCOME_WORDS: Record<ThreadOutcome, string> = {
  done: "done",
  failed: "failed",
  unfinished: "not finished",
};

// Each report is clipped so old, long reports don't fill the main chat.
export const UPDATE_REPORT_MAX = 400;
const CLIP_MARK = "… (read_thread for the rest)";

const clipReport = (text: string): string => {
  const one = text.replace(/\s*\n\s*/g, " ").trim();
  return one.length > UPDATE_REPORT_MAX ? `${one.slice(0, UPDATE_REPORT_MAX).trimEnd()}${CLIP_MARK}` : one;
};

export function threadsUpdate(threads: PlanThread[] | undefined): string {
  const ended = (threads ?? []).filter((t) => t.status);
  if (ended.length === 0) return "";
  return [
    "Plans that ran in their own sessions (threads), and how they ended:",
    ...ended.map(
      (t) => `- ${OUTCOME_WORDS[t.status!]}: ${t.summary}` + (t.report?.text ? `\n  Report: ${clipReport(t.report.text)}` : ""),
    ),
  ].join("\n");
}

// A text without the lines that are only a verdict of the step check ("STEP
// DONE" or "STEP NOT DONE", any case, an ending . or ! allowed): a verdict is
// a signal for the plan runner, not something the thread said. Trimmed.
const VERDICT_LINE = /^\s*step\s+(not\s+)?done\s*[.!]?\s*$/i;

export function withoutVerdictLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !VERDICT_LINE.test(line))
    .join("\n")
    .trim();
}

// The thread's own last words: the last assistant message that has any text
// besides a verdict line (withoutVerdictLines), whole and without that line;
// "" when there is none. A message that is only a verdict is skipped, so the
// words before it count. The note shows it on request and read_thread gives
// it to the chat's model.
export function finalMessage(messages: ChatMessage[] | undefined): string {
  for (const m of [...(messages ?? [])].reverse()) {
    if (m?.role !== "assistant" || typeof m.content !== "string") continue;
    const text = withoutVerdictLines(m.content);
    if (text) return text;
  }
  return "";
}

// A finished plan's result: the last words the model said in its last step
// (the messages that step's turn made), whole; "" when the plan isn't finished
// or that step said nothing. Not the chat's last message, which may be a
// reply to something said after the plan.
export function planResult(steps: PlanStep[] | null | undefined, messages: ChatMessage[]): string {
  if (!steps || steps.length === 0 || !steps.every((s) => s.status === "done")) return "";
  const id = steps[steps.length - 1].id;
  return finalMessage(messages.filter((m) => m.planStep === id));
}

// "850ms" -> "<1s", 12 000 -> "12s", 125 000 -> "2m 5s", 3 720 000 -> "1h 2m".
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

const OUTCOME_LINE: Record<Exclude<ThreadStatus, "missing">, string> = {
  done: "SUCCESS",
  failed: "FAILED",
  unfinished: "NOT FINISHED",
};

// What a thread's plan came to, in pieces, so a caller that has to fit a size
// can keep the important ones (server/threads.ts does). `steps` has one entry
// per step: its line without the note, the whole note, and whether it is the
// step the thread is stuck on. `result` is the head of the Result line and the
// words after it (empty when the head says it all).
export interface ThreadResultParts {
  outcome: string;
  steps: { head: string; note: string; problem: boolean }[];
  result: { head: string; text: string };
  next: string;
}

export function threadResultParts(child: Pick<Session, "plan" | "messages">): ThreadResultParts {
  const steps = child.plan ?? [];
  const messages = child.messages ?? [];
  const status = threadStatus(child) as Exclude<ThreadStatus, "missing">;
  const parts: ThreadResultParts = {
    outcome: `Outcome: ${OUTCOME_LINE[status]}`,
    steps: steps.map((s, i) => ({
      head: `${i + 1}. [${[s.status, s.ms !== undefined ? duration(s.ms) : ""].filter(Boolean).join(", ")}] ${stepLine(s)}`,
      note: s.note?.trim() ?? "",
      problem: false,
    })),
    result: { head: "Result:", text: "" },
    next: "",
  };

  if (steps.length === 0) {
    parts.result.head = "Result: none yet. The thread has no plan.";
    parts.next = "Next: open the thread and make a plan, or ask there.";
    return parts;
  }

  const open = steps.findIndex((s) => s.status !== "done");
  if (open < 0) {
    parts.result.text = planResult(steps, messages) || "(the last step said nothing)";
    return parts;
  }

  const stuck = steps[open];
  const said = finalMessage(messages.filter((m) => m.planStep === stuck.id));
  parts.result = { head: `Result: none yet. Step ${open + 1} last said:`, text: said || "(nothing)" };

  const n = open + 1;
  const problem = steps.find((s) => s.status === "failed" || s.status === "disputed" || s.status === "waiting") ?? stuck;
  const pn = steps.indexOf(problem) + 1;
  parts.steps[pn - 1].problem = true;
  switch (problem.status) {
    case "failed":
      parts.next = `Next: step ${pn} failed. Open the thread, fix what its note says, then Continue.`;
      break;
    case "disputed":
      parts.next = `Next: the check said step ${pn} is not done, but the model showed it is. Open the thread and decide; Continue after.`;
      break;
    case "waiting":
      parts.next = `Next: step ${pn} is waiting for an answer. Open the thread and answer it, then Continue.`;
      break;
    default:
      parts.next = `Next: the thread stopped before step ${n} finished (no run is going). Open the thread and Continue.`;
  }
  return parts;
}

// What a thread's plan came to, as plain text for the chat that started it
// (read_thread and the report prompt). Built from the plan and the steps'
// messages, never from the chat's last message:
//   Outcome: SUCCESS | FAILED | NOT FINISHED
//   Steps: one line each with its state, how long it took and its whole note
//   Result: the plan's result when every step is done; otherwise the last
//     words of the first step that is not done
//   Next: what to do, for a failed, disputed, waiting or unfinished thread
export function threadResult(child: Pick<Session, "plan" | "messages">): string {
  const p = threadResultParts(child);
  return [
    p.outcome,
    ...p.steps.map((s) => (s.note ? `${s.head} - ${s.note.replace(/\n/g, "\n    ")}` : s.head)),
    p.result.text ? `${p.result.head} ${p.result.text}` : p.result.head,
    ...(p.next ? [p.next] : []),
  ].join("\n");
}

// The status part of the note's line, in plain words ("Done in a thread"): the
// heading of the note, with the summary shown under it. Before the status is
// known (undefined) the thread is shown as running.
export function threadStatusWord(status: ThreadStatus | undefined): string {
  switch (status) {
    case "done":
      return "Done in a thread";
    case "failed":
      return "Failed in a thread";
    case "unfinished":
      return "Not finished in a thread";
    case "missing":
      return "Thread was deleted";
    default:
      return "Running in a thread";
  }
}

// The note's whole line: the status word, then the summary.
export function threadLabel(status: ThreadStatus | undefined, summary: string): string {
  return `${threadStatusWord(status)}: ${summary}`;
}

// Splits a report into the lines worth showing on their own and the rest.
// Lines starting with "Follow-up:" (success) or "Next:" (failure), in any case
// and with leading spaces allowed, go to followUp, kept whole and trimmed. One
// that says "none" counts as no follow-up and is dropped. Everything else, in
// order and trimmed, is the body.
export function reportParts(text: string): { body: string; followUp: string[] } {
  const followUp: string[] = [];
  const rest: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*(follow-up|next):\s*(.*)$/i.exec(line);
    if (!m) {
      rest.push(line);
      continue;
    }
    if (!/^none\.?$/i.test(m[2].trim())) followUp.push(line.trim());
  }
  return { body: rest.join("\n").trim(), followUp };
}

// How a note shows its thread's pending question: "answer" when the note can
// carry the prompt itself (approve or deny a command or a change, allow a
// folder), "open" when it can't show it well (a file or folder to find), so the
// note says it needs you and opens the thread.
export function noteAskKind(ask: Ask): "answer" | "open" {
  if ("needsApproval" in ask) return "answer";
  if ("needsAccess" in ask && ask.needsAccess.kind) return "answer";
  return "open";
}

// Where a thread's work lives, in words, one line per worktree (see
// server/worktreeStatus.ts for the numbers, which come from git):
//   "In worktree ui-updates (llama/ui-updates): 5 files uncommitted, 2 commits not on main"
//   "In worktree ui-updates (llama/ui-updates): all committed and on main"
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function worktreeLine(w: WorktreeStatus): string {
  const base = w.base ?? "main";
  const parts: string[] = [];
  if (w.uncommitted > 0) parts.push(`${plural(w.uncommitted, "file", "files")} uncommitted`);
  if (w.unmerged && w.unmerged > 0) parts.push(`${plural(w.unmerged, "commit", "commits")} not on ${base}`);
  if (parts.length === 0) parts.push(w.unmerged === null ? "all committed" : `all committed and on ${base}`);
  return `In worktree ${w.name} (${w.branch ?? "detached HEAD"}): ${parts.join(", ")}`;
}

// No worktrees: no lines, so nothing shows.
export const worktreeLines = (rows: WorktreeStatus[] | undefined): string[] => (rows ?? []).map(worktreeLine);
