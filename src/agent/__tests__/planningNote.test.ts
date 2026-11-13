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
  it("is only the question line by default", () => {
    expect(PLANNING_NOTE).toBe(
      "If this message is a question or otherwise doesn't change files, just answer it, and don't mention plans.",
    );
    expect(planningNote()).toBe(PLANNING_NOTE);
  });

  it("no longer repeats the size rule, which Builder holds", () => {
    expect(PLANNING_NOTE).not.toContain(DEFAULT_WORK_POLICY);
    expect(PLANNING_NOTE).not.toContain("Decide by size");
    expect(PLANNING_NOTE).not.toContain("update_plan");
  });

  it("no longer tells the model to only plan or not to change files", () => {
    expect(PLANNING_NOTE).not.toContain("only plan");
    expect(PLANNING_NOTE).not.toContain("Don't change any files");
  });

  it("puts custom text after the question line, instead of the default rule", () => {
    const note = planningNote("Never run commands.");
    expect(note.startsWith(QUESTION_START)).toBe(true);
    expect(note.endsWith("Never run commands.")).toBe(true);
    expect(note.indexOf("don't mention plans.")).toBeLessThan(note.indexOf("Never run commands."));
    expect(note).not.toContain(DEFAULT_WORK_POLICY);
  });

  it("falls back to the default for a blank custom text", () => {
    expect(planningNote("   ")).toBe(PLANNING_NOTE);
  });

  it("always starts with the question sentence", () => {
    expect(PLANNING_NOTE.startsWith(QUESTION_START)).toBe(true);
    expect(planningNote("Custom.").startsWith(QUESTION_START)).toBe(true);
  });
});
