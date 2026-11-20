// Says "the work list may have changed, ask again": the one place that does it.
// It first forgets the shared saved list (through a hook the list's own module
// registers, so this file needn't import it), and only then publishes the
// global "work" event, so a page that reloads the moment it hears the event
// gets a fresh answer, never the old saved one. The event carries no list and no
// buttons; it only means "ask again".

import { publish } from "./runHub.ts";

let clearHook: (() => void) | undefined;

// The list's module registers how to forget its saved answers.
export function onWorkChangedClear(hook: () => void): void {
  clearHook = hook;
}

export function workChanged(): void {
  clearHook?.();
  publish({ type: "work", id: "", data: {} });
}
