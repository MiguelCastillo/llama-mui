import { describe, expect, it } from "vitest";
import { limitLevel, limitMessage } from "../usageLimit";

describe("limitLevel", () => {
  it("is none when no limit is set", () => {
    expect(limitLevel(1_000_000, 0)).toBe("none");
    expect(limitLevel(5, -1)).toBe("none");
  });
  it("is none below 80%", () => expect(limitLevel(79, 100)).toBe("none"));
  it("warns from 80% up to the limit", () => {
    expect(limitLevel(80, 100)).toBe("warn");
    expect(limitLevel(99, 100)).toBe("warn");
  });
  it("is over at and past 100%", () => {
    expect(limitLevel(100, 100)).toBe("over");
    expect(limitLevel(150, 100)).toBe("over");
  });
});

describe("limitMessage", () => {
  it("is null when fine", () => expect(limitMessage(10, 100)).toBeNull());
  it("says sending still works when over", () => expect(limitMessage(120, 100)).toMatch(/passed.*Sending still works/));
  it("gives a percentage when close", () => expect(limitMessage(85, 100)).toMatch(/85%/));
});
