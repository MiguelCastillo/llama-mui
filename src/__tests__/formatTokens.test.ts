import { describe, expect, it } from "vitest";
import { formatTokens } from "../formatTokens";

describe("formatTokens", () => {
  it("shows small counts as they are", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(999)).toBe("999");
  });
  it("uses k with one decimal at most", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(12_000)).toBe("12k");
  });
  it("uses M for millions", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(3_000_000)).toBe("3M");
  });
  it("moves to M instead of showing 1000k", () => {
    expect(formatTokens(999_960)).toBe("1M");
  });
  it("treats bad input as 0", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
  });
});
