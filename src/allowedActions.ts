// What the open chat offers, decided in one place and drawn only if listed.
//
// A button, an edit control or the send box is drawn only when its action is in
// the list `allowedActions` returns. The default is nothing: while the chat is
// still being read, or who holds its run is not known, no action is offered.
// So a new situation can only take buttons away until someone adds them back
// here, and nothing is drawn first and hidden afterwards.
//
// Who holds the run (see the server's "holder"): 'none' (no run), 'here' (this
// server runs it) or 'elsewhere' (another server does). Elsewhere, the only
// thing offered is Take over: this server must not touch what that one writes.

import type { PlanStep } from "./api";

export type Action =
  | "run" // start the plan that hasn't started
  | "continue" // go on with a plan that has
  | "pause"
  | "discard"
  | "clone"
  | "edit" // change the plan's steps
  | "resend" // send the failed message again
  | "send" // type and send a message
  | "takeOver";

export type Holder = "unknown" | "none" | "here" | "elsewhere";

// What a plan card needs to know about its steps.
export interface PlanState {
  finished: boolean; // every step is done: nothing in it runs again
  unfinished: boolean; // the next step is pending, failed or waiting: Run or Continue has something to do
  started: boolean; // a step has run, or was stopped with a note: the button says Continue
  running: boolean;
}

export function planState(steps: PlanStep[], running: boolean): PlanState {
  const next = steps.find((s) => s.status !== "done");
  return {
    finished: steps.every((s) => s.status === "done"),
    unfinished: next?.status === "pending" || next?.status === "failed" || next?.status === "waiting",
    started: steps.some((s) => s.status !== "pending" || !!s.note),
    running,
  };
}

export interface Situation {
  loaded: boolean; // the open chat has been read
  holder: Holder;
  plan: PlanState | null; // null: the chat has no plan
  canClone: boolean; // a finished plan can be started again from this chat
  hasModel: boolean; // a model is chosen, so a message can be sent
}

export function allowedActions({ loaded, holder, plan, canClone, hasModel }: Situation): ReadonlySet<Action> {
  const allowed = new Set<Action>();
  if (!loaded || holder === "unknown") return allowed;
  if (holder === "elsewhere") return allowed.add("takeOver");

  if (hasModel || plan?.running) allowed.add("send");
  allowed.add("resend");
  if (!plan) return allowed;

  if (plan.unfinished && !plan.running) allowed.add(plan.started ? "continue" : "run");
  if (plan.running) allowed.add("pause");
  if (!plan.finished) allowed.add("edit"); // the step rows decide what is editable while it runs
  if (!plan.finished && !plan.running) allowed.add("discard");
  if (plan.finished && canClone) allowed.add("clone");
  return allowed;
}
