// The cause of what is happening right now, so a low-level line (a command run,
// a fetch, a file write) can say which chat, tool call or request it came from
// without every function passing the ids down. Set by the tool wrapper
// (tools.ts) and the api handler (plugin.ts); read with currentCause().
//
// Only short plain ids go in here: never a body, header, argument or content.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type Cause = {
  session?: string;
  // The id of one tool call (also on its tool.call line).
  call?: string;
  // The id of one api request (also on its api.request line).
  request?: string;
  who?: { address: string; agent: string };
};

const store = new AsyncLocalStorage<Cause>();

// Runs fn with the cause set for everything it starts, awaited or not. A cause
// nested inside another adds to it: the fields given replace the same ones.
export function runWithCause<T>(cause: Cause, fn: () => T): T {
  return store.run({ ...store.getStore(), ...cause }, fn);
}

// Runs fn with no cause at all, for work that belongs to nobody (the minute's
// summary of batched writes, which a timer started inside a chat would
// otherwise stamp with that chat).
export function runWithoutCause<T>(fn: () => T): T {
  return store.exit(fn);
}

// The cause of the current work, or an empty object outside any.
export function currentCause(): Cause {
  return store.getStore() ?? {};
}

// A short random id for a call or a request.
export const newId = () => randomBytes(4).toString("hex");
