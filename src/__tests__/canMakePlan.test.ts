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

  it("is on for a worktree removal and a page opening in a chat reply", () => {
    for (const type of ["worktree", "page"]) expect(canMakePlan(type, "turn")).toBe(true);
    for (const type of ["worktree", "page"]) expect(canMakePlan(type, "plan")).toBe(false);
  });

  it("is on for the questions about a path in a chat reply: one to allow, one to find", () => {
    for (const type of ["access", "location"]) expect(canMakePlan(type, "turn")).toBe(true);
    for (const type of ["access", "location"]) expect(canMakePlan(type, "plan")).toBe(false);
  });

  it("is off for a kind of prompt it doesn't know", () => {
    expect(canMakePlan("", "turn")).toBe(false);
    expect(canMakePlan("something-else", "turn")).toBe(false);
  });
});
