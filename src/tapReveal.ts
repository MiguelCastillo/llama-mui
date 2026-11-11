// Tap-to-reveal for the small toolbars on messages, tables and plan steps. On
// touch screens they stay hidden until the box they belong to is tapped; tapping
// it again, or anywhere else, hides them. Only one box is open at a time, so the
// id of the open box lives in one small store shared by all of them.

import { useCallback, useEffect, useId, useSyncExternalStore, type MouseEvent } from "react";

export type TapReveal = {
  // The id of the open box, or null when none is open.
  get: () => string | null;
  // Opens the box with this id, or closes it if it is the open one.
  toggle: (id: string) => void;
  // Closes whatever is open.
  close: () => void;
  // Calls `listener` on each change; the returned function stops it.
  subscribe: (listener: () => void) => () => void;
};

export function createTapReveal(): TapReveal {
  let open: string | null = null;
  const listeners = new Set<() => void>();
  const set = (next: string | null) => {
    if (next === open) return;
    open = next;
    listeners.forEach((l) => l());
  };
  return {
    get: () => open,
    toggle: (id) => set(open === id ? null : id),
    close: () => set(null),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

// The one store the whole app shares.
export const tapReveal = createTapReveal();

// The attribute that carries a box's id, so a tap anywhere on the page can be
// traced back to the box it landed in.
const ID_ATTRIBUTE = "data-tap-reveal-id";

// Whether a tap on `target` landed inside the box with this id (or inside a box
// nested within it).
export function isInsideBox(target: TapTarget | null, id: string | null): boolean {
  if (!target || id === null) return false;
  return Boolean(target.closest(`[${ID_ATTRIBUTE}="${id}"]`));
}

let listening = false;

// Installs, once, the page-wide listener that closes the open box when a tap
// lands outside it.
function listenForOutsideTaps() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("pointerdown", (event) => {
    const open = tapReveal.get();
    if (open === null) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!isInsideBox(target, open)) tapReveal.close();
  });
}

// Props to spread on the outer element of a box whose toolbar should appear on
// tap. On devices with hover the styles ignore the open mark, so this is
// harmless there.
export function useTapReveal() {
  const id = useId();
  const open = useSyncExternalStore(tapReveal.subscribe, tapReveal.get) === id;
  useEffect(listenForOutsideTaps, []);
  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      // Only the innermost box handles the tap, so a box nested in another
      // does not also toggle the outer one.
      event.stopPropagation();
      const target = event.target instanceof Element ? event.target : null;
      if (shouldToggle(target, window.getSelection()?.toString() ?? "", event.currentTarget)) {
        tapReveal.toggle(id);
      }
    },
    [id],
  );
  return {
    onClick,
    [ID_ATTRIBUTE]: id,
    "data-tap-open": open ? "" : undefined,
  };
}

// Things a tap on which does its own job, so it must not also open or close a
// toolbar: links, buttons, form fields, anything marked as a button, and the
// header of a folding section.
const OWN_JOB =
  'a, button, input, textarea, select, [role="button"], .MuiAccordionSummary-root';

// Only what shouldToggle needs from a tapped element, so it can be tested
// without a browser.
export type TapTarget = { closest: (selector: string) => unknown };

// Whether a tap on `target` should open or close its box's toolbar. It should
// not when the tap is on (or inside) something with its own job, or when the
// user has text selected, since the tap is then most likely about the selection.
//
// `box` is the box's own element, for one that is itself marked as a button (a
// row that unfolds on tap): that mark alone does not count as another job, only
// a button or link between the tap and the box does.
export function shouldToggle(
  target: TapTarget | null,
  selectionText: string,
  box?: TapBox | null,
): boolean {
  if (!target) return false;
  if (selectionText.length > 0) return false;
  const job = target.closest(OWN_JOB);
  return !job || (box != null && job === box);
}

// The box's own element, compared by identity with what `closest` finds.
export type TapBox = unknown;
