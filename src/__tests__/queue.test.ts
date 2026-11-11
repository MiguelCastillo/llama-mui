import { describe, expect, it } from "vitest";
import { pausedReason, readQueue } from "../queue";
import { PANEL_VARIANTS } from "../Panel";

describe("pausedReason", () => {
  it("names a failed reply", () => {
    expect(pausedReason("The server went away")).toBe("Paused because the reply failed");
  });

  it("is a Stop when nothing failed", () => {
    expect(pausedReason(null)).toBe("Paused because you stopped the reply");
    expect(pausedReason(undefined)).toBe("Paused because you stopped the reply");
  });
});

describe("the queued look", () => {
  it("has its own panel variant, lighter than a sent message", () => {
    expect(PANEL_VARIANTS.queued).toBeTruthy();
    expect(PANEL_VARIANTS.queued).not.toBe(PANEL_VARIANTS.message);
  });
});

describe("readQueue", () => {
  it("keeps the order and drops items without text", () => {
    const item = (id: string, text: string) => ({ id, text, options: { model: "m", toolsOn: false, thinkOn: false }, queuedAt: 1 });
    expect(readQueue([item("a", "one"), item("b", "  "), item("c", "three")]).map((q) => q.id)).toEqual(["a", "c"]);
  });
});
