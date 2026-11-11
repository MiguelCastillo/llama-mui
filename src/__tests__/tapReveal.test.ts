import { describe, expect, it, vi } from "vitest";
import { createTapReveal, isInsideBox, shouldToggle } from "../tapReveal";

describe("isInsideBox", () => {
  const within = (id: string) => ({
    closest: (selector: string) => (selector === `[data-tap-reveal-id="${id}"]` ? {} : null),
  });

  it("is true for a tap inside the box with that id", () => {
    expect(isInsideBox(within(":r1:"), ":r1:")).toBe(true);
  });

  it("is false for a tap in another box, with no target, or with nothing open", () => {
    expect(isInsideBox(within(":r2:"), ":r1:")).toBe(false);
    expect(isInsideBox(null, ":r1:")).toBe(false);
    expect(isInsideBox(within(":r1:"), null)).toBe(false);
  });
});

describe("createTapReveal", () => {
  it("starts with nothing open", () => {
    expect(createTapReveal().get()).toBeNull();
  });

  it("opens a box on the first tap and closes it on the second", () => {
    const store = createTapReveal();
    store.toggle("a");
    expect(store.get()).toBe("a");
    store.toggle("a");
    expect(store.get()).toBeNull();
  });

  it("keeps only one box open: tapping another closes the first", () => {
    const store = createTapReveal();
    store.toggle("a");
    store.toggle("b");
    expect(store.get()).toBe("b");
  });

  it("close() hides whatever is open and does nothing when nothing is", () => {
    const store = createTapReveal();
    const listener = vi.fn();
    store.subscribe(listener);
    store.close();
    expect(listener).not.toHaveBeenCalled();
    store.toggle("a");
    store.close();
    expect(store.get()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tells listeners on each change, and stops once one unsubscribes", () => {
    const store = createTapReveal();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.toggle("a");
    store.toggle("b");
    store.toggle("b");
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    store.toggle("c");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

// A fake tapped element: `closest` answers yes when one of the selector's parts
// is among the things the tap is on or inside.
function tappedOn(...inside: string[]) {
  return {
    closest: (selector: string) => {
      const parts = selector.split(",").map((s) => s.trim());
      return inside.some((i) => parts.includes(i)) ? {} : null;
    },
  };
}

describe("shouldToggle", () => {
  it("toggles for a tap on plain text", () => {
    expect(shouldToggle(tappedOn(), "")).toBe(true);
  });

  it("does not toggle without a target", () => {
    expect(shouldToggle(null, "")).toBe(false);
  });

  it.each(["a", "button", "input", "textarea", "select", '[role="button"]', ".MuiAccordionSummary-root"])(
    "does not toggle for a tap on or inside %s",
    (selector) => {
      expect(shouldToggle(tappedOn(selector), "")).toBe(false);
    },
  );

  it("does not toggle while text is selected", () => {
    expect(shouldToggle(tappedOn(), "some words")).toBe(false);
  });

  it("toggles when the only job found is the box's own element", () => {
    const box = {};
    const onBox = { closest: () => box };
    expect(shouldToggle(onBox, "")).toBe(false);
    expect(shouldToggle(onBox, "", box)).toBe(true);
  });

  it("does not toggle for a button inside the box, even when the box is a button too", () => {
    const box = {};
    const onInner = { closest: () => ({}) };
    expect(shouldToggle(onInner, "", box)).toBe(false);
  });
});
