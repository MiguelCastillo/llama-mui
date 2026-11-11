// Whether a reply shows its steps (the "3 steps" lines and, while it runs, the
// live line), kept in this browser, not on the server. The page reads it before
// its first draw, so a reload doesn't flash steps and then hide them, which
// the old server-side setting did (it was only known once settings loaded).
// Off unless turned on, per device.

import { useSyncExternalStore } from "react";

const KEY = "llama-mui:show-steps";

export function readShowSteps(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setShowSteps(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts until the page closes, as nothing keeps it.
    memory = on;
  }
  listeners.forEach((l) => l());
}

// Only used when storage can't be written.
let memory: boolean | null = null;
const current = () => (memory ?? readShowSteps());

function subscribe(l: () => void) {
  listeners.add(l);
  // Another tab changing it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export const useShowSteps = (): boolean => useSyncExternalStore(subscribe, current);
