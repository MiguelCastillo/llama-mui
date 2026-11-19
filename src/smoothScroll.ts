// Smooth following of the bottom of the chat. Pure: no React, no DOM.
//
// Each animation frame the caller reads the current scroll position and the
// current target (the bottom, which keeps moving while text streams) and asks
// nextScrollTop for where to go this frame. The step is a fraction of the
// remaining distance that depends on the elapsed time, so the result is the
// same at 60 and 120 frames a second, a far target is approached quickly, a
// near one gently, and a target that moves is simply followed.

/** How long the remaining distance takes to shrink to a third, in ms. */
export const FOLLOW_TIME_CONSTANT_MS = 90

/** Closer than this (in scroll units) to the target counts as arrived. */
export const ARRIVED_WITHIN = 0.5

/** A frame longer than this (a hidden tab, a stall) is treated as this long. */
export const MAX_FRAME_MS = 100

/** Scroll positions can be rounded by the browser; this much counts as the same. */
export const OWN_SCROLL_TOLERANCE = 1

/**
 * The next scrollTop for one frame. Moves from `current` toward `target` by an
 * eased share of the distance; never passes the target, and returns the target
 * exactly once it is within ARRIVED_WITHIN. If the target is above the current
 * position (the content got shorter) it returns the target at once.
 */
export function nextScrollTop(current: number, target: number, elapsedMs: number): number {
  const distance = target - current
  if (distance <= ARRIVED_WITHIN) return target
  const dt = Math.min(Math.max(elapsedMs, 0), MAX_FRAME_MS)
  const share = 1 - Math.exp(-dt / FOLLOW_TIME_CONSTANT_MS)
  const next = current + distance * share
  if (target - next <= ARRIVED_WITHIN) return target
  return Math.min(next, target)
}

/** True once the position is at the target, so the loop can stop. */
export function hasArrived(current: number, target: number): boolean {
  return Math.abs(target - current) <= ARRIVED_WITHIN
}

/**
 * Whether a scroll event was caused by us. `lastSet` is the position we most
 * recently wrote (null when we have written none since the last user scroll).
 * An event at that position is ours and must not count as the user scrolling
 * up; any other position is the user's.
 */
export function isOwnScroll(scrollTop: number, lastSet: number | null): boolean {
  return lastSet !== null && Math.abs(scrollTop - lastSet) <= OWN_SCROLL_TOLERANCE
}
