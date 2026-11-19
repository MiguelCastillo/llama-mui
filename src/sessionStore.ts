// The open chat's saved data (SessionState, see sessionState.ts), kept in one
// small store outside React, like the message box (messageBox.ts) and the
// steps setting (showSteps.ts):
// - There is one copy. Rendering reads it through a subscription
//   (useSyncExternalStore(store.subscribe, store.get)); code that runs between
//   awaits (a send, the plan runner, tool calls) reads store.get(), which is
//   always the latest state, never a value from an older render.
// - update is the one way to change it: a partial change, or a function from
//   the current state to one. A change that alters nothing (every key the
//   same by Object.is) is dropped: no listener runs, so nothing redraws and
//   the save timer doesn't restart.
// - Each change of the message list is reported to the onMessages hooks as
//   msgs:<source>:<before>><after> (counts only), so the scroll recorder shows
//   what dropped or added a message.
// No React here.

import { emptySessionState, type SessionState } from "./sessionState";

export type SessionChange = Partial<SessionState> | ((current: SessionState) => Partial<SessionState>);

export type SessionStore = {
  // The state now. The same object until something changes.
  get: () => SessionState;
  // Applies a change; `source` names where a new message list came from.
  update: (change: SessionChange, source?: string) => void;
  // Calls `listener` after each change that altered something; the returned
  // function stops it.
  subscribe: (listener: () => void) => () => void;
  // Calls `hook` with a trace mark each time the message list changes; the
  // returned function stops it.
  onMessages: (hook: (mark: string) => void) => () => void;
};

export function createSessionStore(initial: SessionState = emptySessionState()): SessionStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const messageHooks = new Set<(mark: string) => void>();
  const listen =
    <T>(set: Set<T>) =>
    (item: T) => {
      set.add(item);
      return () => void set.delete(item);
    };
  return {
    get: () => state,
    update: (change, source = "page") => {
      const current = state;
      const part = typeof change === "function" ? change(current) : change;
      const keys = Object.keys(part) as (keyof SessionState)[];
      if (keys.every((k) => Object.is(current[k], part[k]))) return;
      if (part.messages && part.messages !== current.messages) {
        const mark = `msgs:${source}:${current.messages.length}>${part.messages.length}`;
        messageHooks.forEach((h) => h(mark));
      }
      state = { ...current, ...part };
      listeners.forEach((l) => l());
    },
    subscribe: listen(listeners),
    onMessages: listen(messageHooks),
  };
}
