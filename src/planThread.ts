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
import type { ChatMessage, PlanStep, PlanThread, Session, ThreadOutcome } from "./api.ts";
import { stepLine } from "./agent/plan.ts";
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

// The note's line, in plain words. Before the status is known (undefined) the
// thread is shown as running.
export function threadLabel(status: ThreadStatus | undefined, summary: string): string {
  switch (status) {
    case "done":
      return `Done in a thread: ${summary}`;
    case "failed":
      return `Failed in a thread: ${summary}`;
    case "unfinished":
      return `Not finished in a thread: ${summary}`;
    case "missing":
      return `Thread was deleted: ${summary}`;
    default:
      return `Running in a thread: ${summary}`;
  }
}
