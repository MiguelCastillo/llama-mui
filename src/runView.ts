// What the page knows of a plan's run, and the two small pure helpers that read
// it. The run itself is on the server (server/runners.ts); src/runClient.ts
// keeps these views current from its events. No React in this file.

import type { Session } from "./api";
import type { Answer, Ask } from "./runnerTypes";

export type RunnerStatus = "running" | "pausing" | "paused" | "waiting" | "stopped";

// What a listener sees. A new object after every change.
export interface RunnerView {
  sessionId: string;
  // A plan, or "turn": one chat reply that the server is streaming (a message
  // sent to a session with no plan running). A turn has no steps, no Pause and
  // takes no messages until it is over.
  kind: "plan" | "turn";
  // The run's session as the server has it now, or null for a run the page
  // only knows of from the list (nobody has its session open, or the first
  // snapshot hasn't come yet). Final once the status is "stopped".
  session: Session | null;
  status: RunnerStatus;
  // The pending ask and the way to answer it (a command to the server). The
  // same object while it is the same ask.
  ask: { ask: Ask; decide: (answer: Answer) => void } | null;
  error: string | null;
  // A request is in flight (a step's reply or its check).
  streaming: boolean;
  startedAt: number;
  // Messages the user sent to the run that no step has seen yet, and the step
  // (counting from 1) that will see each. Once a step starts they are in the
  // chat, marked "Seen by step N".
  notes: { id: string; text: string; step: number }[];
}

// A runner needs the user when it waits on an ask, or stopped with a step
// that asked a question (a waiting step).
export function needsYou(view: RunnerView | undefined | null): boolean {
  if (!view) return false;
  if (view.ask) return true;
  return view.status === "stopped" && !!view.session?.plan?.some((st) => st.status === "waiting");
}

// The plan card's Pause control: a short caption, and the button, if any.
// Pause only while running; Resume while paused. While it is pausing, or
// waiting on an ask, there is nothing to press.
export function pauseControl(status: RunnerStatus | undefined | null): {
  text: string | null;
  button: "Pause" | "Resume" | null;
} {
  switch (status) {
    case "running":
      return { text: null, button: "Pause" };
    case "pausing":
      return { text: "Pausing after this step", button: null };
    case "paused":
      return { text: "Paused", button: "Resume" };
    default:
      return { text: null, button: null };
  }
}
