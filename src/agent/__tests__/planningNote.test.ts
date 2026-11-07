import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_POLICY, workPolicy } from "../workPolicy";
import { PLANNING_NOTE, planningNote } from "../plan";

const QUESTION_START = "If this message is a question or otherwise doesn't change files, just answer it";

describe("workPolicy", () => {
  it("states the size rule", () => {
    expect(DEFAULT_WORK_POLICY.startsWith("Decide by size.")).toBe(true);
    expect(DEFAULT_WORK_POLICY).toContain("write a plan with update_plan and stop");
    expect(DEFAULT_WORK_POLICY).toContain("bigger than it looked");
    expect(DEFAULT_WORK_POLICY).toContain("Questions need no plan.");
  });

  it("gives the default for nothing or blank text, and custom text otherwise", () => {
    expect(workPolicy()).toBe(DEFAULT_WORK_POLICY);
    expect(workPolicy("  \n")).toBe(DEFAULT_WORK_POLICY);
    expect(workPolicy("  Always plan.  ")).toBe("Always plan.");
  });
});

describe("planningNote", () => {
  it("contains the default work policy", () => {
    expect(PLANNING_NOTE).toContain(DEFAULT_WORK_POLICY);
    expect(planningNote()).toBe(PLANNING_NOTE);
  });

  it("puts the policy after the question sentence", () => {
    expect(PLANNING_NOTE.endsWith(DEFAULT_WORK_POLICY)).toBe(true);
    expect(PLANNING_NOTE.indexOf("don't mention plans.")).toBeLessThan(PLANNING_NOTE.indexOf(DEFAULT_WORK_POLICY));
  });

  it("no longer tells the model to only plan or not to change files", () => {
    expect(PLANNING_NOTE).not.toContain("only plan");
    expect(PLANNING_NOTE).not.toContain("Don't change any files");
  });

  it("uses a custom text instead of the default", () => {
    const note = planningNote("Never run commands.");
    expect(note).toContain("Never run commands.");
    expect(note).not.toContain(DEFAULT_WORK_POLICY);
  });

  it("falls back to the default for a blank custom text", () => {
    expect(planningNote("   ")).toBe(PLANNING_NOTE);
  });

  it("still starts with the question sentence", () => {
    expect(PLANNING_NOTE.startsWith(QUESTION_START)).toBe(true);
    expect(planningNote("Custom.").startsWith(QUESTION_START)).toBe(true);
  });
});
