// What a restart does to runs that were going. A run lives in the server's
// memory, so when the server stops (a restart, a crash, closing the terminal)
// the run is gone, and its record in session.json (see runHub.ts) is all that is
// left of it. At start-up, each session whose file still has such a record is
// settled, once:
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
// decides. A restart that finds no record (the run had ended, or a save came
// from a page) changes nothing.

import { readdir } from "node:fs/promises";
import { INTERRUPTED } from "../src/agent/helpers.ts";
import type { ChatMessage, PlanStep } from "../src/api.ts";
import { closeOpenToolCalls } from "../src/closeOpenToolCalls.ts";
import { sessionsDir } from "./disk.ts";
import * as hub from "./runHub.ts";
import { reportInterrupted } from "./threadReport.ts";

export const INTERRUPTED_NOTE = "Interrupted by a restart";

// The session as a restart leaves it, for the run record that was found with
// it. Pure: the session it is given doesn't change.
export function markInterrupted(session: any, run: hub.RunState): any {
  let wasRunning = false;
  const plan: PlanStep[] | null = Array.isArray(session.plan)
    ? session.plan.map((st: PlanStep) => {
        if (st.status !== "running") return st;
        wasRunning = true;
        const keep = st.answer ? { answer: st.answer, asked: st.asked } : {};
        return { id: st.id, text: st.text, ...(st.summary ? { summary: st.summary } : {}), status: "pending", note: INTERRUPTED_NOTE, ...keep };
      })
    : null;

  const unseen: ChatMessage[] = (run.notes ?? []).map((n) => ({ role: "user", content: n.text, notSeen: true }));
  const messages = [...closeOpenToolCalls(Array.isArray(session.messages) ? session.messages : []), ...unseen];

  const cutOff = run.kind === "turn" || run.streaming === true || wasRunning;
  // Messages waiting in the queue are kept, and paused: nothing is sent by itself after a restart.
  const waiting = Array.isArray(session.queue) && session.queue.length > 0;
  return { ...session, plan, messages, failed: cutOff ? INTERRUPTED : (session.failed ?? null), ...(waiting ? { queuePaused: true } : {}) };
}

// Settles every session with a stale run record. Resolves with the ids it
// changed. One session that can't be read or written is a warning in the log
// and doesn't stop the others.
export async function recoverInterruptedRuns(): Promise<string[]> {
  const names = await readdir(sessionsDir).catch(() => [] as string[]);
  const settled: string[] = [];
  for (const id of names) {
    try {
      let after: any = null;
      let kind: hub.RunState["kind"];
      const changed = await hub.settleStale(id, (session, run) => {
        kind = run.kind;
        return (after = markInterrupted(session, run));
      });
      if (!changed) {
        // No run to settle, but a queue that was left waiting stays paused.
        await hub.pauseQueue(id);
        continue;
      }
      settled.push(id);
      // A reply in a thread isn't the thread's plan: only a plan run is reported.
      if (kind !== "turn") await reportInterrupted(id, after);
    } catch (e) {
      console.warn(`Couldn't settle the interrupted run in session ${id}: ${e}`);
    }
  }
  return settled;
}

let recovered: Promise<string[]> | undefined;

// Once per process, however many servers start in it (dev and preview, a
// restart of the dev server by a changed config): a run that began after the
// first call is live, not stale, and is left alone anyway (see settleStale).
export function recoverOnce(): Promise<string[]> {
  return (recovered ??= recoverInterruptedRuns()
    .then((ids) => {
      if (ids.length) console.info(`${ids.length} plan run${ids.length === 1 ? " was" : "s were"} interrupted by the restart. Press Continue to go on.`);
      return ids;
    })
    .catch((e) => {
      console.warn(`Couldn't look for interrupted runs: ${e}`);
      return [];
    }));
}
