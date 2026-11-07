import { describe, expect, it } from "vitest";
import { reasonOf } from "../toolkit";

describe("reasonOf", () => {
  it("returns the reason trimmed", () => {
    expect(reasonOf({ reason: "  Checking which commit that is \n" })).toBe("Checking which commit that is");
  });

  it("clips long reasons to 200 characters", () => {
    const out = reasonOf({ reason: "a".repeat(500) });
    expect(out).toBe("a".repeat(200));
  });

  it("keeps a reason of exactly 200 characters whole", () => {
    expect(reasonOf({ reason: "b".repeat(200) })).toBe("b".repeat(200));
  });

  it("is undefined when empty, blank or missing", () => {
    expect(reasonOf({ reason: "" })).toBeUndefined();
    expect(reasonOf({ reason: "   \n\t" })).toBeUndefined();
    expect(reasonOf({})).toBeUndefined();
  });

  it("is undefined when the reason is not a string or args is not an object", () => {
    expect(reasonOf({ reason: 42 })).toBeUndefined();
    expect(reasonOf({ reason: null })).toBeUndefined();
    expect(reasonOf(undefined)).toBeUndefined();
    expect(reasonOf("text")).toBeUndefined();
  });
});
