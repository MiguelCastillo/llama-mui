// !! PRINCIPLE (see AGENTS.md, "THE SERVER DECIDES WHAT A PLAN CARD CAN DO") !!
// The server decides what a plan card, the edit controls, the approval prompt
// (Approve, Deny, Approve all) and the send box can do; the page only draws what the server lists, and draws nothing until it has
// answered. Do NOT add page-side rules or local patches (such as hiding one
// button for one case). Unknown is never "nobody": a missing or unreadable run
// record, or an owner that can't be told, removes every action, it never adds
// one. A page may take an action away for a reason only it knows (no model
// chosen removes 'send'); it must never add one.
//
// The default is nothing. A new situation can only take actions away until
// someone adds them back here.
//
// Who holds the run: 'none' (no run), 'here' (this server runs it), 'elsewhere'
// (another server does) or 'unknown' (the record can't be read). Elsewhere, the
// only thing offered is Take over: this server must not touch what that one
// writes.

import type { PlanStep } from "../src/api.ts";
import { holderOf, ownerOf, serverId, type RunRecord } from "./runRecord.ts";

export type Action =
  | "run" // start the plan that hasn't started
  | "continue" // go on with a plan that has
  | "pause"
  | "discard"
  | "clone"
  | "edit" // change the plan's steps
  | "resend" // send the failed message again
  | "send" // type and send a message
  | "approve" // answer an approval prompt: Approve, Deny, and both "Approve all ... in this session"
  | "takeOver";

export type Holder = "unknown" | "none" | "here" | "elsewhere";

// What a plan card needs to know about its steps.
export interface PlanState {
  finished: boolean; // every step is done: nothing in it runs again
  unfinished: boolean; // the next step is pending, failed or waiting: Run or Continue has something to do
  started: boolean; // a step has run, or was stopped with a note: the button says Continue
  running: boolean;
  // A step is marked running in what is shown: the plan can't be discarded.
  stepRunning?: boolean;
}

export function planState(steps: PlanStep[], running: boolean): PlanState {
  const next = steps.find((s) => s.status !== "done");
  return {
    finished: steps.every((s) => s.status === "done"),
    unfinished: next?.status === "pending" || next?.status === "failed" || next?.status === "waiting",
    started: steps.some((s) => s.status !== "pending" || !!s.note),
    running,
    stepRunning: steps.some((s) => s.status === "running"),
  };
}

export interface Situation {
  loaded: boolean; // the session has been read
  holder: Holder;
  plan: PlanState | null; // null: the chat has no plan
  canClone: boolean; // a finished plan can be started again from this chat
  // The server has no say on whether a model is chosen; it always lists 'send'
  // where sending is possible and the page may remove it. Tests may pass false.
  hasModel?: boolean;
}

export function allowedActions({ loaded, holder, plan, canClone, hasModel = true }: Situation): ReadonlySet<Action> {
  const allowed = new Set<Action>();
  if (!loaded || holder === "unknown") return allowed;
  if (holder === "elsewhere") return allowed.add("takeOver");

  if (hasModel || plan?.running) allowed.add("send");
  allowed.add("resend");
  allowed.add("approve");
  if (!plan) return allowed;

  if (plan.unfinished && !plan.running) allowed.add(plan.started ? "continue" : "run");
  if (plan.running) allowed.add("pause");
  if (!plan.finished) allowed.add("edit"); // the step rows decide what is editable while it runs
  if (!plan.finished && !plan.running && !plan.stepRunning) allowed.add("discard");
  if (plan.finished && canClone) allowed.add("clone");
  return allowed;
}

// Who holds the run, from its record. No record: nobody. A record whose owner
// is dead: nobody (it is settled as interrupted). A record with no readable
// owner at all can't be judged: unknown.
export function holderKind(run: RunRecord | null | undefined, now: number = Date.now(), me: string = serverId): Holder {
  if (run === null || run === undefined) return "none";
  if (typeof run !== "object" || !ownerOf(run)) return "unknown";
  const holder = holderOf(run, now, me);
  if (!holder) return "none";
  return holder.mine ? "here" : "elsewhere";
}

// The actions to list for a saved session and its run record (null if no run).
// The list is sorted so equal situations give equal lists. `now` and `me` are
// passed in so tests can stand in for another server or a fake clock.
export function sessionActions(
  session: { plan?: unknown } | null | undefined,
  run: RunRecord | null | undefined,
  now: number = Date.now(),
  me: string = serverId,
): Action[] {
  if (!session || typeof session !== "object") return [];
  const holder = holderKind(run, now, me);
  const steps = Array.isArray(session.plan) ? (session.plan as PlanStep[]).filter((s) => s && typeof s === "object") : null;
  const hasPlan = !!steps && steps.length > 0;
  const running = holder === "here" && !!run && run.kind !== "turn";
  const plan = hasPlan ? planState(steps!, running) : null;
  const canClone = !!plan?.finished && holder === "none";
  return [...allowedActions({ loaded: true, holder, plan, canClone })].sort();
}
