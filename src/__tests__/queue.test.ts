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
    const item = (id: string, text: string) => ({ id, text, options: { model: "m", toolsOn: false }, queuedAt: 1 });
    expect(readQueue([item("a", "one"), item("b", "  "), item("c", "three")]).map((q) => q.id)).toEqual(["a", "c"]);
  });

  const base = { id: "a", text: "hi", queuedAt: 1 };

  it("keeps a message's settings object, and drops what isn't a setting", () => {
    const item = (modelOptions: unknown) => ({ ...base, options: { model: "m", toolsOn: false, modelOptions } });
    const [kept, junk] = readQueue([item({ think: true, effort: "low" }), item({ think: "yes", effort: "lots", other: 1 })]);
    expect(kept.options.modelOptions).toEqual({ think: true, effort: "low" });
    expect(junk.options.modelOptions).toEqual({});
  });

  it("reads an older item's thinkOn and effort as the settings object", () => {
    const [old, oldOff, oldBad] = readQueue([
      { ...base, options: { model: "m", toolsOn: false, thinkOn: true, effort: "high" } },
      { ...base, options: { model: "m", toolsOn: false, thinkOn: false } },
      { ...base, options: { model: "m", toolsOn: false, thinkOn: true, effort: "lots" } },
    ]);
    expect(old.options).toEqual({ model: "m", toolsOn: false, modelOptions: { think: true, effort: "high" } });
    expect(oldOff.options.modelOptions).toEqual({ think: false });
    expect(oldBad.options.modelOptions).toEqual({ think: true });
    expect(old.options).not.toHaveProperty("thinkOn");
  });

  it("an item with neither has an empty object", () => {
    expect(readQueue([{ ...base, options: { model: "m", toolsOn: false } }])[0].options.modelOptions).toEqual({});
  });
});
