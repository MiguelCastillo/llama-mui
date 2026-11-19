import { describe, expect, it } from "vitest";
import { endsPin, isScrollKey, type PinInput } from "../pinRelease";

describe("endsPin", () => {
  it("never ends the pin on a plain scroll, whatever moved it", () => {
    // The keyboard closing on a phone grows the box and moves scrollTop.
    expect(endsPin({ kind: "scroll", delta: 280 })).toBe(false);
    // The spacer shrinking makes the browser clamp scrollTop upward.
    expect(endsPin({ kind: "scroll", delta: -96 })).toBe(false);
    // A steps line or re-rendered markdown above shifts it by a little.
    expect(endsPin({ kind: "scroll", delta: 3 })).toBe(false);
    expect(endsPin({ kind: "scroll", delta: 0 })).toBe(false);
  });

  it("ends the pin on a wheel that scrolls vertically", () => {
    expect(endsPin({ kind: "wheel", deltaY: -40 })).toBe(true);
    expect(endsPin({ kind: "wheel", deltaY: 12 })).toBe(true);
    expect(endsPin({ kind: "wheel", deltaY: 0 })).toBe(false);
  });

  it("ends the pin on a drag, not on a tap", () => {
    expect(endsPin({ kind: "touchstart" })).toBe(false);
    expect(endsPin({ kind: "touchmove" })).toBe(true);
  });

  it("ends the pin on scroll keys outside text fields", () => {
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]) {
      expect(endsPin({ kind: "key", key, editable: false })).toBe(true);
      expect(endsPin({ kind: "key", key, editable: true })).toBe(false);
    }
    expect(endsPin({ kind: "key", key: "a", editable: false })).toBe(false);
    expect(endsPin({ kind: "key", key: "Enter", editable: false })).toBe(false);
  });

  it("ends the pin on a scrollbar drag and an arrow tap", () => {
    expect(endsPin({ kind: "scrollbar" })).toBe(true);
    expect(endsPin({ kind: "arrow" })).toBe(true);
  });

  it("ends the pin on a pending question, a session switch and a new send", () => {
    expect(endsPin({ kind: "pending" })).toBe(true);
    expect(endsPin({ kind: "session" })).toBe(true);
    expect(endsPin({ kind: "send" })).toBe(true);
  });

  it("leaves the pin alone for an input it doesn't know", () => {
    expect(endsPin({ kind: "resize" } as unknown as PinInput)).toBe(false);
  });
});

describe("isScrollKey", () => {
  it("knows the keys that scroll", () => {
    expect(isScrollKey("PageDown")).toBe(true);
    expect(isScrollKey("Spacebar")).toBe(true);
    expect(isScrollKey("Tab")).toBe(false);
  });
});
