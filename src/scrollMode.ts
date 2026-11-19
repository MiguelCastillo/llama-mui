// What the chat does with the view when a reply runs, kept in this browser like
// the Show steps choice (see showSteps.ts), so the page knows it before it draws.
//   "follow": keep the newest text in view (the default).
//   "pin":    move the sent message to the top and let the reply fill below it.

import { useSyncExternalStore } from "react";

export type ScrollMode = "follow" | "pin";

const KEY = "llama-mui:scroll-mode";

const valid = (v: unknown): v is ScrollMode => v === "follow" || v === "pin";

export function readScrollMode(): ScrollMode {
  try {
    const v = localStorage.getItem(KEY);
    return valid(v) ? v : "follow";
  } catch {
    return "follow";
  }
}

// Whether a send moves the message to the top (only in "pin"); otherwise the
// chat follows the bottom.
export const pinsOnSend = (mode: ScrollMode): boolean => mode === "pin";

const listeners = new Set<() => void>();

// Only used when storage can't be written.
let memory: ScrollMode | null = null;

export function setScrollMode(mode: ScrollMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Storage blocked: the choice lasts until the page closes.
    memory = mode;
  }
  listeners.forEach((l) => l());
}

const current = (): ScrollMode => memory ?? readScrollMode();

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export const useScrollMode = (): ScrollMode => useSyncExternalStore(subscribe, current);
