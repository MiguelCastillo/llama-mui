// When to show the small toolbars on messages, tables and plan steps. A toolbar
// is drawn only while it shows (see useToolbarReveal): its box is hovered with a
// mouse, has keyboard focus, or was tapped open on a touch screen. On touch
// screens a toolbar stays hidden until its box is tapped; tapping it again, or
// anywhere else, hides it. Only one box is open at a time, so the id of the open
// box lives in one small store shared by all of them.

import {
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

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

// Whether the box's toolbar is showing, and the props to spread on the box's
// outer element. The toolbar shows while:
// - a mouse or pen is over the box (a touch's pointer doesn't count: a finger
//   has no hover, and taps decide instead);
// - focus is in the box and was put there by the keyboard (the browser's
//   :focus-visible), so Tab reaches a toolbar that isn't drawn yet: the box
//   itself takes focus, which draws its toolbar, and the next Tab goes into it.
//   A mouse click that focuses something in the box doesn't count;
// - the box was tapped open (touch screens).
// The box's toolbar draws its buttons only while `shown`, so a long chat
// doesn't keep hundreds of hidden buttons in the page.
//
// Nested boxes (an action box in a reply) each have their own state; being
// over or in the inner box also counts as being in the outer one, as :hover
// and :focus-within did.
export function useToolbarReveal({ focusable = true }: { focusable?: boolean } = {}) {
  const id = useId();
  // A boolean snapshot, so a tap re-renders only the box that opens or closes.
  const tapOpen = useSyncExternalStore(tapReveal.subscribe, () => tapReveal.get() === id);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
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
  const onPointerEnter = useCallback((event: PointerEvent<HTMLElement>) => {
    if (hoversOnPointer(event.pointerType)) setHovered(true);
  }, []);
  const onPointerLeave = useCallback(() => setHovered(false), []);
  // React's focus and blur bubble (focusin, focusout), so these see focus
  // moving anywhere inside the box.
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    setFocused(isKeyboardFocus(event.target));
  }, []);
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false);
  }, []);
  return {
    shown: hovered || focused || tapOpen,
    props: {
      onClick,
      onPointerEnter,
      onPointerLeave,
      onFocus,
      onBlur,
      tabIndex: focusable ? 0 : undefined,
      [ID_ATTRIBUTE]: id,
    },
  };
}

// Whether a pointer of this kind hovers: a mouse or a pen does, a finger
// doesn't (touch screens show a toolbar on tap instead).
export function hoversOnPointer(pointerType: string): boolean {
  return pointerType !== "touch";
}

// Whether focus on this element came from the keyboard, as the browser judges
// it for :focus-visible.
function isKeyboardFocus(target: EventTarget): boolean {
  try {
    return target instanceof Element && target.matches(":focus-visible");
  } catch {
    // A browser without :focus-visible: any focus counts.
    return true;
  }
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
