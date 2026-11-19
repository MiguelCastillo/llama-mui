// When a pinned message stops being pinned (see pinSent.ts for the pin
// itself). The pin ends only on something the user did, or on a rule of the
// chat: never on a scroll alone. A phone moves scrollTop on its own all the
// time (the keyboard closing, the spacer shrinking, a steps line appearing
// above, the browser clamping), and reading those as the user scrolling is
// what made the pin give way and the chat follow the bottom.
// Pure, no DOM: the chat turns each event into a PinInput and asks.

/** Keys that scroll the chat when it has focus. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

export type PinInput =
  /** A mouse wheel or trackpad scroll; deltaY is the vertical amount. */
  | { kind: "wheel"; deltaY: number }
  /** A finger touching the chat; on its own (a tap) it moves nothing. */
  | { kind: "touchstart" }
  /** A finger dragging the chat. */
  | { kind: "touchmove" }
  /** A key pressed; editable is true when it went to a text field, where
   * arrows and space move the caret or type rather than scroll. */
  | { kind: "key"; key: string; editable: boolean }
  /** A press on the scroll box's scrollbar. */
  | { kind: "scrollbar" }
  /** A tap on the jump-to-newest arrow. */
  | { kind: "arrow" }
  /** An approval or a question is waiting for the user's answer. */
  | { kind: "pending" }
  /** The chat switched to another session. */
  | { kind: "session" }
  /** A new send or Resend, which replaces the pin with its own. */
  | { kind: "send" }
  /** A scroll event with none of the inputs above behind it; delta is the
   * scrollTop change, for the record only. */
  | { kind: "scroll"; delta: number };

/** Whether a key scrolls the chat (and so counts as the user scrolling). */
export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}

/** Whether this input ends the pin. A plain scroll never does. */
export function endsPin(input: PinInput): boolean {
  switch (input.kind) {
    case "wheel":
      return input.deltaY !== 0;
    case "touchstart":
      return false;
    case "touchmove":
    case "scrollbar":
    case "arrow":
    case "pending":
    case "session":
    case "send":
      return true;
    case "key":
      return !input.editable && isScrollKey(input.key);
    case "scroll":
      return false;
    default:
      // An input this module doesn't know about leaves the pin alone:
      // unknown never ends it.
      return false;
  }
}
