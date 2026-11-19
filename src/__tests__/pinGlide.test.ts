import { describe, expect, it } from 'vitest'
import { GLIDE_DURATION_MS, GLIDE_START_REM, glideDone, glideScrollTop, glideShift, glideStart } from '../pinGlide'

const LEAD = GLIDE_START_REM * 16

describe('glideStart', () => {
  it('needs no jump when the distance is shorter than the lead', () => {
    expect(glideStart(900, 1000, LEAD)).toBe(900)
  })

  it('jumps to the fixed lead short of a far target', () => {
    expect(glideStart(0, 5000, LEAD)).toBe(5000 - LEAD)
  })

  it('starts from the same place whatever the current position', () => {
    expect(glideStart(0, 5000, LEAD)).toBe(glideStart(3000, 5000, LEAD))
  })

  it('comes from above when the target is above the current position', () => {
    expect(glideStart(5000, 1000, LEAD)).toBe(1000 + LEAD)
    expect(glideStart(1100, 1000, LEAD)).toBe(1100)
  })

  it('treats a negative lead as no lead', () => {
    expect(glideStart(0, 5000, -10)).toBe(5000)
  })
})

describe('glideShift', () => {
  it('moves the start by the same amount as the target', () => {
    expect(glideShift(4840, 5000, 5120)).toBe(4960)
    expect(glideShift(4840, 5000, 4900)).toBe(4740)
    expect(glideShift(4840, 5000, 5000)).toBe(4840)
  })
})

describe('glideScrollTop', () => {
  it('moves toward the target without passing it, and arrives exactly', () => {
    let prev = 4800
    for (let ms = 0; ms <= GLIDE_DURATION_MS; ms += 16) {
      const p = glideScrollTop(4800, 5000, ms)
      expect(p).toBeGreaterThanOrEqual(prev)
      expect(p).toBeLessThanOrEqual(5000)
      prev = p
    }
    expect(glideScrollTop(4800, 5000, GLIDE_DURATION_MS)).toBe(5000)
    expect(glideDone(5000, 5000, GLIDE_DURATION_MS)).toBe(true)
  })

  it('is still on the way halfway through', () => {
    const p = glideScrollTop(4800, 5000, GLIDE_DURATION_MS / 2)
    expect(p).toBeGreaterThan(4800)
    expect(p).toBeLessThan(5000)
    expect(glideDone(p, 5000, GLIDE_DURATION_MS / 2)).toBe(false)
  })

  it('aims at a target that moves during the glide', () => {
    const before = glideScrollTop(4800, 5000, 200)
    const moved = glideScrollTop(4800, 5300, 200)
    expect(moved).toBeGreaterThan(before)
    expect(glideScrollTop(4800, 5300, GLIDE_DURATION_MS)).toBe(5300)
  })

  it('does not overshoot a target that moved behind the start', () => {
    const p = glideScrollTop(4800, 4700, 300)
    expect(p).toBeLessThanOrEqual(4800)
    expect(p).toBeGreaterThanOrEqual(4700)
    expect(glideScrollTop(4800, 4700, GLIDE_DURATION_MS)).toBe(4700)
  })

  it('snaps to the target when within half a unit', () => {
    expect(glideScrollTop(4999.8, 5000, 10)).toBe(5000)
  })
})
