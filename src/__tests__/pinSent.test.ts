import { describe, expect, it } from "vitest";
import { holdPin, pinScrollTop, pinSpacer } from "../pinSent";

describe("pinScrollTop", () => {
  it("puts the message's top at the top room", () => {
    // Box at viewport 0, scrolled 1000, message 500 below the box's top.
    expect(pinScrollTop(0, 1000, 500, 72)).toBe(1428);
    // Box lower in the viewport: only the offset inside the box counts.
    expect(pinScrollTop(50, 1000, 550, 72)).toBe(1428);
  });
  it("never goes below 0", () => {
    expect(pinScrollTop(0, 0, 10, 72)).toBe(0);
  });
});

describe("pinSpacer", () => {
  const view = 800;
  const top = 72;
  const end = 100;

  it("gives a positive spacer for a short reply", () => {
    // Message at 2000, content ends at 2100: the view needs to reach 2728.
    expect(pinSpacer(view, top, end, 2000, 2100, null)).toBe(528);
  });
  it("gives 0 when the reply is taller than the view", () => {
    expect(pinSpacer(view, top, end, 2000, 3000, null)).toBe(0);
    expect(pinSpacer(view, top, end, 2000, 3000, 528)).toBe(0);
  });
  it("shrinks as the reply grows", () => {
    const first = pinSpacer(view, top, end, 2000, 2100, null);
    const later = pinSpacer(view, top, end, 2000, 2300, first);
    expect(later).toBe(328);
  });
  it("never grows back", () => {
    // Content got shorter (or the view taller) after the spacer shrank.
    expect(pinSpacer(view, top, end, 2000, 2100, 200)).toBe(200);
    expect(pinSpacer(1200, top, end, 2000, 2100, 0)).toBe(0);
  });
});

describe("holdPin", () => {
  const top = 72;
  const end = 100;
  // Message at 2000, reply ends at 2100, pinned: scrollTop 1928, spacer 528.

  it("writes nothing when the message is already at the top", () => {
    expect(holdPin(800, top, end, 2000, 2100, 1928)).toEqual({ spacer: 528, scrollTop: null });
    // A sub-pixel difference isn't corrected.
    expect(holdPin(800, top, end, 2000, 2100, 1928.6).scrollTop).toBeNull();
  });
  it("grows the spacer and puts the message back when the keyboard closes", () => {
    // The box grows from 800 to 1100. With the old spacer (528) the end was
    // at 2100 + 100 + 528 = 2728, so the browser clamped scrollTop to
    // 2728 - 1100 = 1628. The spacer grows to 828 and scrollTop goes back to 1928.
    expect(holdPin(1100, top, end, 2000, 2100, 1628)).toEqual({ spacer: 828, scrollTop: 1928 });
  });
  it("follows the message when content above it grows", () => {
    // A steps line above adds 40: the message and the end move down by 40.
    expect(holdPin(800, top, end, 2040, 2140, 1928)).toEqual({ spacer: 528, scrollTop: 1968 });
  });
  it("shrinks the spacer as the reply grows, without moving the view", () => {
    expect(holdPin(800, top, end, 2000, 2400, 1928)).toEqual({ spacer: 228, scrollTop: null });
    expect(holdPin(800, top, end, 2000, 4000, 1928)).toEqual({ spacer: 0, scrollTop: null });
  });
  it("never targets a scrollTop below 0", () => {
    expect(holdPin(800, top, end, 30, 100, 10)).toEqual({ spacer: 558, scrollTop: 0 });
  });
});
