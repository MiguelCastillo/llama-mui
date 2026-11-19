import { describe, expect, it } from 'vitest'
import { ARRIVED_WITHIN, hasArrived, isOwnScroll, nextScrollTop } from '../smoothScroll'

// Runs frames of 16 ms; `targetAt` gives the target for each frame.
function run(start: number, targetAt: (frame: number) => number, frames: number) {
  const seen: number[] = []
  let pos = start
  for (let i = 0; i < frames; i++) {
    pos = nextScrollTop(pos, targetAt(i), 16)
    seen.push(pos)
  }
  return seen
}

describe('nextScrollTop', () => {
  it('moves toward the target without passing it', () => {
    const seen = run(0, () => 1000, 200)
    let prev = 0
    for (const p of seen) {
      expect(p).toBeGreaterThanOrEqual(prev)
      expect(p).toBeLessThanOrEqual(1000)
      prev = p
    }
  })

  it('arrives exactly, within a short time', () => {
    const seen = run(0, () => 1000, 120) // about 2 seconds
    expect(seen[seen.length - 1]).toBe(1000)
    const arrivedAt = seen.findIndex((p) => p === 1000)
    expect(arrivedAt).toBeLessThan(90)
  })

  it('does not jump the whole way in one frame', () => {
    const first = nextScrollTop(0, 1000, 16)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(500)
  })

  it('follows a target that keeps moving and never overshoots it', () => {
    // The content grows for 100 frames, then stops growing.
    const target = (i: number) => 500 + Math.min(i, 100) * 20
    const seen = run(0, target, 250)
    seen.forEach((p, i) => expect(p).toBeLessThanOrEqual(target(i)))
    // While it grows, the view trails by a bounded amount, not far behind.
    expect(target(99) - seen[99]).toBeLessThan(300)
    // Once it stops growing, the view arrives exactly.
    expect(seen[seen.length - 1]).toBe(target(249))
  })

  it('goes to a target above it at once', () => {
    expect(nextScrollTop(800, 600, 16)).toBe(600)
  })

  it('takes a long frame as a capped one', () => {
    expect(nextScrollTop(0, 1000, 60_000)).toBe(nextScrollTop(0, 1000, 100))
  })

  it('counts a tiny remaining distance as arrived', () => {
    expect(nextScrollTop(999.7, 1000, 16)).toBe(1000)
    expect(hasArrived(1000 - ARRIVED_WITHIN, 1000)).toBe(true)
    expect(hasArrived(990, 1000)).toBe(false)
  })
})

describe('isOwnScroll', () => {
  it('recognises the position we just wrote, allowing for rounding', () => {
    expect(isOwnScroll(420, 420)).toBe(true)
    expect(isOwnScroll(420.4, 420)).toBe(true)
  })

  it('treats any other position as the user', () => {
    expect(isOwnScroll(300, 420)).toBe(false)
  })

  it('treats everything as the user when we have written nothing', () => {
    expect(isOwnScroll(420, null)).toBe(false)
  })
})
