import { describe, expect, it } from "vitest";
import { canMarkDone } from "../agent/plan";

describe("canMarkDone", () => {
  it("is on for a disputed step", () => {
    expect(canMarkDone("disputed")).toBe(true);
  });

  it("is on for a failed step", () => {
    expect(canMarkDone("failed")).toBe(true);
  });

  it("is off for every other status", () => {
    for (const status of ["pending", "running", "done", "waiting"] as const) {
      expect(canMarkDone(status)).toBe(false);
    }
  });
});
