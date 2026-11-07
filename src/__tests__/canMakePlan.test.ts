import { describe, expect, it } from "vitest";
import { canMakePlan } from "../approvalWhy";

describe("canMakePlan", () => {
  it("is on for a command in a chat reply", () => {
    expect(canMakePlan("command", "turn")).toBe(true);
  });

  it("is on for a file change in a chat reply", () => {
    expect(canMakePlan("change", "turn")).toBe(true);
  });

  it("is off for a command or a change in a plan run", () => {
    expect(canMakePlan("command", "plan")).toBe(false);
    expect(canMakePlan("change", "plan")).toBe(false);
  });

  it("is off when no run is open", () => {
    for (const type of ["command", "change"]) {
      expect(canMakePlan(type, undefined)).toBe(false);
      expect(canMakePlan(type, null)).toBe(false);
    }
  });

  it("is off for approvals that are neither a command nor a change", () => {
    for (const type of ["page", "worktree"]) expect(canMakePlan(type, "turn")).toBe(false);
  });
});
