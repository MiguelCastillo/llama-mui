// Which thread a plan that is about to run goes to. This is the one place that
// decides. Today the answer is always "a new one": every plan gets its own
// nested session (see planToThread in src/planThread.ts).
//
// A router will replace this function later, to send a plan to a thread that
// already exists (say, one working on the same project) when that fits. The
// answer will then also be { kind: "existing", sessionId } and the caller
// will add the plan to that thread, its note pointing at it by planId. The
// caller handles only "new" now, so a second kind can't be forgotten: the
// compiler points at the switch.

import type { PlanStep, Session } from "../src/api.ts";

export type ThreadChoice = { kind: "new" };

export function chooseThread(_parent: Session, _plan: PlanStep[]): ThreadChoice {
  return { kind: "new" };
}
