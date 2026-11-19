// Pinning a sent message to the top of the chat: after a plain send or
// Resend, the chat scrolls so the user's message sits just below the floating
// toolbar, and the reply flows in below it without the view moving.
// Pure arithmetic, no DOM: the chat measures and passes the numbers in (all in
// CSS pixels, as the browser reports them).

/**
 * The scrollTop that puts the message's top edge at the top room.
 * boxTop and msgTop are viewport positions (getBoundingClientRect().top) of the
 * scroll box and the message; scrollTop is the box's current scrollTop;
 * topRoomPx is the box's top padding (the room kept clear of the toolbar).
 * Never below 0.
 */
export function pinScrollTop(
  boxTop: number,
  scrollTop: number,
  msgTop: number,
  topRoomPx: number,
): number {
  return Math.max(0, scrollTop + (msgTop - boxTop) - topRoomPx);
}

/**
 * The height of the spacer drawn after the messages, so there is enough to
 * scroll for the message to sit at the top room.
 * viewHeight is the scroll box's visible height (clientHeight); endRoomPx is
 * the box's bottom padding; msgTop and contentBottom are positions inside the
 * scroll content (from its top, spacer not included) of the message's top and
 * the end of the messages. previous is the spacer's current height, or null
 * when nothing is pinned yet.
 * The spacer only shrinks while pinned (never larger than previous), so a
 * reply that grows never makes the content jump; it is never below 0.
 */
export function pinSpacer(
  viewHeight: number,
  topRoomPx: number,
  endRoomPx: number,
  msgTop: number,
  contentBottom: number,
  previous: number | null,
): number {
  // Scrolled to pin, the view shows content from msgTop - topRoomPx down to
  // msgTop - topRoomPx + viewHeight; the content, spacer and end room must
  // reach that far.
  const needed = msgTop - topRoomPx + viewHeight - contentBottom - endRoomPx;
  const height = Math.max(0, Math.ceil(needed));
  return previous === null ? height : Math.min(previous, height);
}

/**
 * Keeping a held pin in place after the layout changed under it (the box
 * growing when the phone keyboard closes, a steps line or markdown above the
 * message changing height, the reply growing). Same measures as pinSpacer,
 * plus the box's current scrollTop.
 * The spacer is worked out afresh (not only shrinking), so a box that grew
 * still has room for the message to sit at the top; scrollTop is where the
 * message's top meets the top room, or null when it is already there (within
 * 1, so a sub-pixel difference writes nothing).
 */
export function holdPin(
  viewHeight: number,
  topRoomPx: number,
  endRoomPx: number,
  msgTop: number,
  contentBottom: number,
  scrollTop: number,
): { spacer: number; scrollTop: number | null } {
  const spacer = pinSpacer(viewHeight, topRoomPx, endRoomPx, msgTop, contentBottom, null);
  const target = Math.max(0, msgTop - topRoomPx);
  return { spacer, scrollTop: Math.abs(scrollTop - target) <= 1 ? null : target };
}
