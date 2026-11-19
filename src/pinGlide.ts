// The glide that brings a sent message up to the top. Pure: no React, no DOM.
//
// On a pinned send the stop is the message's place right under the top bar,
// in content coordinates (the message's offset in the content minus the top
// room), so it doesn't move when the keyboard opens or closes. The page jumps
// to a start a fixed GLIDE_START_REM short of the stop (glideStart; the caller
// turns rem into px with the root font size), the same on phone and desktop.
// Each animation frame asks glideScrollTop where to be. If content above the
// message changes height, the caller moves start and stop together
// (glideShift). The glide takes GLIDE_DURATION_MS, eases out, never passes the
// stop and ends exactly on it.

import { ARRIVED_WITHIN } from './smoothScroll'

/** How long the glide from the start point to the target takes, in ms. */
export const GLIDE_DURATION_MS = 500

/** How far short of the stop the glide starts, in rem (the caller converts to px). */
export const GLIDE_START_REM = 10

/**
 * Where to jump before gliding: `leadPx` short of the target, on the side the
 * page is coming from, and never further from the target than the current
 * position (a short distance needs no jump).
 */
export function glideStart(current: number, target: number, leadPx: number): number {
  const lead = Math.max(leadPx, 0)
  if (target >= current) return Math.max(current, target - lead)
  return Math.min(current, target + lead)
}

/**
 * The start moved by the same amount the target moved, so a change in the
 * height of content above the message keeps the glide's distance the same.
 */
export function glideShift(start: number, oldTarget: number, newTarget: number): number {
  return start + (newTarget - oldTarget)
}

/** Ease-out cubic: fast at first, gentle at the end. 0 → 0, 1 → 1. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * The scrollTop for this frame of a glide that began at `start` `elapsedMs`
 * ago, aiming at `target`. Stays between start and target (no overshoot), and
 * returns the target exactly once the duration is over or the remaining
 * distance is under ARRIVED_WITHIN.
 */
export function glideScrollTop(start: number, target: number, elapsedMs: number): number {
  if (elapsedMs >= GLIDE_DURATION_MS) return target
  const t = Math.max(elapsedMs, 0) / GLIDE_DURATION_MS
  const next = start + (target - start) * easeOut(t)
  if (Math.abs(target - next) <= ARRIVED_WITHIN) return target
  const lo = Math.min(start, target)
  const hi = Math.max(start, target)
  return Math.min(Math.max(next, lo), hi)
}

/** True once the glide is over, so the frame loop can stop. */
export function glideDone(position: number, target: number, elapsedMs: number): boolean {
  return elapsedMs >= GLIDE_DURATION_MS || Math.abs(target - position) <= ARRIVED_WITHIN
}
