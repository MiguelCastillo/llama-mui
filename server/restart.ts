// What happens to a run whose server is gone. A run lives in its server's
// memory, so when that server stops (a restart, a crash, closing the terminal)
// the run is gone, and its record in session.json (see runHub.ts) is all that is
// left of it. Several servers can share the same sessions, so a record that is
// not in this process's memory is not necessarily dead: its owner is dead only
// when it has not checked in for 20 seconds (see ownerAlive in runRecord.ts).
// Starting a server settles nothing and rewrites no session. A session whose
// record has a dead owner is settled when it is opened (and before Resend or
// Continue), once:
//
//  - a step that was running goes back to pending, with the note "Interrupted
//    by a restart" (an answer the user had given it is kept, as Stop keeps it);
//  - a question the run was waiting on is gone with the record: nothing can
//    answer it now, and Continue asks again if the step still needs it;
//  - a tool call that never got its result is closed (closeOpenToolCalls), so
//    the next request to the model isn't refused for it;
//  - a message the user sent to the plan that no step had seen goes into the
//    chat marked as not seen, so the text isn't lost;
//  - `failed` says "interrupted" if a request was in flight, as a reload in the
//    middle of a reply always has, so the chat shows the reply was cut off;
//  - messages waiting in the session's queue are kept and the queue is paused
//    (a session with a queue and no run record is paused too);
//  - the record is removed, and the revision goes up like any server write;
//  - for a thread, the note in its parent says it did not finish.
//
// Nothing starts again by itself: the plan card shows Continue, and the user
// decides. A session with no record (the run had ended, or a save came from a
// page), or with a record whose owner is alive, is changed in no way.

import { readdir } from "node:fs/promises";
import { INTERRUPTED } from "../src/agent/helpers.ts";
import type { EndKind } from "../src/runEnd.ts";
import type { ChatMessage, PlanStep } from "../src/api.ts";
import { callsWaitingForAnswer, closeOpenToolCalls } from "../src/closeOpenToolCalls.ts";
import { sessionsDir } from "./disk.ts";
import * as hub from "./runHub.ts";
import { effectOfCall } from "./tools.ts";
import { reportInterrupted } from "./threadReport.ts";

export const INTERRUPTED_NOTE = "Interrupted by a restart";

const MAX_FILES = 10;
const MAX_CALLS = 5;
const MAX_ARG = 60;
const ARG_KEYS = ["command", "cmd", "path", "file_path", "filePath", "file", "filename"];

// "run_command (npm test)": the tool and a short piece of the call's own
// command or path, one line, capped. Never anything else from the arguments
// (file contents stay out).
export function describeCall(c: { name: string; arguments: string }): string {
  let arg = "";
  try {
    const a = JSON.parse(c.arguments);
    const key = ARG_KEYS.find((k) => typeof a?.[k] === "string" && a[k]);
    if (key) arg = String(a[key]).replace(/\s+/g, " ").trim();
  } catch {
    // Arguments that aren't JSON: just the name.
  }
  if (arg.length > MAX_ARG) arg = arg.slice(0, MAX_ARG - 1) + "…";
  return arg ? `${c.name} (${arg})` : c.name;
}

// Calls with the started mark and no result: they were running when the app stopped.
function callsInFlight(messages: ChatMessage[]): string[] {
  const answered = new Set<string>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) answered.add(m.toolCallId);
  const out: string[] = [];
  for (const m of messages) for (const c of m.toolCalls ?? []) if (c.started && !answered.has(c.id)) out.push(describeCall(c));
  return out;
}

const more = (list: string[], max: number) => (list.length > max ? [...list.slice(0, max), `and ${list.length - max} more`] : list);

// The note for a step that was running: the plain words, then what was in
// flight and which files changed, when known.
export function interruptedNote(messages: ChatMessage[], changed: string[] = [], why: string = INTERRUPTED_NOTE): string {
  const calls = callsInFlight(messages);
  const parts: string[] = [];
  if (calls.length) parts.push(`In progress: ${more(calls, MAX_CALLS).join("; ")}.`);
  if (changed.length) parts.push(`Files changed since the run started: ${more(changed, MAX_FILES).join(", ")}.`);
  return parts.length ? `${why}. ${parts.join(" ")}` : why;
}

// A reply that was streaming when the app stopped is saved as it stood: a last
// assistant message with text and no calls (calls are only added once the reply
// is complete). It stays on screen, marked cut off, and is left out of the next
// request (the model writes the whole reply again). Only when the run record
// says the request in flight was a reply: a step's check also streams, and then
// the last message is a complete answer, which is never marked. A record from
// an older build has no kind of request, and is left alone too.
export function markCutOffReply(messages: ChatMessage[], run: hub.RunState): ChatMessage[] {
  if (run.streaming !== true || run.request !== "reply") return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.toolCalls?.length) return messages;
  return [...messages.slice(0, -1), { ...last, cutOff: true }];
}

// The session as a restart leaves it, for the run record that was found with
// it. Pure: the session it is given doesn't change. `changed` is the list of
// files the run record kept (its `changed` field), found by the caller.
export function markInterrupted(session: any, run: hub.RunState, changed: string[] = [], why?: string, endedBy?: EndKind): any {
  let wasRunning = false;
  const note = interruptedNote(Array.isArray(session.messages) ? session.messages : [], changed, why);
  const plan: PlanStep[] | null = Array.isArray(session.plan)
    ? session.plan.map((st: PlanStep) => {
        if (st.status !== "running") return st;
        wasRunning = true;
        const keep = st.answer ? { answer: st.answer, asked: st.asked } : {};
        return { id: st.id, text: st.text, ...(st.summary ? { summary: st.summary } : {}), status: "pending", note, ...keep };
      })
    : null;

  const unseen: ChatMessage[] = (run.notes ?? []).map((n) => ({ role: "user", content: n.text, notSeen: true }));
  const before: ChatMessage[] = markCutOffReply(Array.isArray(session.messages) ? session.messages : [], run);
  // A run that stopped with a question pending never started that call.
  const waitingCalls = run.ask ? callsWaitingForAnswer(before) : [];
  const messages = [...closeOpenToolCalls(before, waitingCalls, (c) => effectOfCall(c.name, c.arguments), run.marksCalls === true), ...unseen];

  const cutOff = run.kind === "turn" || run.streaming === true || wasRunning;
  // Messages waiting in the queue are kept, and paused: nothing is sent by itself after a restart.
  const waiting = Array.isArray(session.queue) && session.queue.length > 0;
  // The kind: the one asked for (a take-over), else the one the run record kept.
  const kind = endedBy ?? run.endedBy;
  return {
    ...session,
    plan,
    messages,
    failed: cutOff ? INTERRUPTED : (session.failed ?? null),
    ...(kind && cutOff ? { endedBy: kind } : {}),
    ...(waiting ? { queuePaused: true } : {}),
  };
}

// Settles one session if its run record has a dead owner (see settleStale in
// runHub.ts): the run is marked interrupted and the record removed. A record
// whose owner is alive, on any server, is left alone. True if it changed the
// session. Called when a session is opened, and before Resend or Continue.
export async function settleSession(id: string): Promise<boolean> {
  let after: any = null;
  let kind: hub.RunState["kind"];
  const changed = await hub.settleStale(id, (session, run) => {
    kind = run.kind;
    return (after = markInterrupted(session, run, Array.isArray(run.changed) ? run.changed : []));
  });
  if (!changed) return false;
  // A reply in a thread isn't the thread's plan: only a plan run is reported.
  if (kind !== "turn") await reportInterrupted(id, after);
  return true;
}

// The user takes over another server's live run: settled as interrupted at
// once (the same way a dead owner's run is, but without the wait), the record
// removed. Answers the old holder's port. Refused (409) when no other server
// holds the floor (see takeOver in runHub.ts).
export async function takeOverSession(id: string): Promise<{ port: number; reason: string }> {
  let reason = "";
  const done = await hub.takeOver(id, (session, run) => {
    reason = `Interrupted: you took over from the server on port ${run.owner?.port ?? "unknown"}`;
    return markInterrupted(session, run, Array.isArray(run.changed) ? run.changed : [], reason, "taken-over");
  });
  if (done.kind !== "turn") await reportInterrupted(id, done.session);
  return { port: done.port, reason };
}

// Settles every session whose run record has a dead owner. Resolves with the
// ids it changed. Not called at start-up. One session that can't be read or written is a warning in the log
// and doesn't stop the others.
export async function recoverInterruptedRuns(): Promise<string[]> {
  const names = await readdir(sessionsDir).catch(() => [] as string[]);
  const settled: string[] = [];
  for (const id of names) {
    try {
      if (await settleSession(id)) settled.push(id);
      else await hub.pauseQueue(id); // no run to settle, but a queue left waiting stays paused
    } catch (e) {
      console.warn(`Couldn't settle the interrupted run in session ${id}: ${e}`);
    }
  }
  return settled;
}
