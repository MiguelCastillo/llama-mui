import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackReport, parseReport, reportPrompt } from "../agent/threadReport";
import type { ChatMessage, PlanStep } from "../api";

const step = (n: number, status: PlanStep["status"], extra: Partial<PlanStep> = {}): PlanStep => ({
  id: `s${n}`,
  text: `Step ${n} text`,
  summary: `Do thing ${n}`,
  status,
  ...extra,
});

describe("reportPrompt", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "Please do two things" },
    { role: "assistant", content: "First answer", planStep: "s1" },
    { role: "assistant", content: "I changed a.ts and b.ts.\nSTEP NOT DONE", planStep: "s2" },
    { role: "assistant", content: "STEP NOT DONE", planStep: "s2" },
    { role: "assistant", content: "   " },
  ];

  it("asks for a sentence or two when it worked, a Next line when it didn't, and names what was asked, the plan and each step", () => {
    const prompt = reportPrompt({
      summary: "Do two things",
      request: "Please do two things",
      steps: [step(1, "done"), step(2, "failed", { note: "npm test failed" })],
      messages,
    });
    expect(prompt).toMatch(/under about 400 characters/);
    expect(prompt).toContain("one or two plain sentences that it worked");
    expect(prompt).toContain("no file lists, numbers or commands");
    expect(prompt).toContain('"Follow-up:" only if the user must do something');
    expect(prompt).toContain("restart the server, commit, answer a question");
    expect(prompt).toContain('"Next:" giving the one concrete move');
    expect(prompt).not.toContain("Follow-up: none");
    expect(prompt).not.toContain("paths, branches");
    expect(prompt).toContain("What the user asked for:\nPlease do two things");
    expect(prompt).toContain("The plan: Do two things");
    expect(prompt).toContain("1. Do thing 1: done");
    expect(prompt).toContain("2. Do thing 2: failed (npm test failed)");
    // The plan's real result: the outcome, the troubled step's note and what that
    // step last said, never a verdict line.
    expect(prompt).toContain("How the thread ended:\nOutcome: FAILED");
    expect(prompt).toContain("2. [failed] Do thing 2 - npm test failed");
    expect(prompt).toContain("Step 2 last said: I changed a.ts and b.ts.");
    expect(prompt).toContain("Next: step 2 failed.");
    expect(prompt).not.toMatch(/STEP NOT DONE/i);
    expect(prompt).not.toContain("The last thing the model said");
    expect(prompt).not.toContain("The user stopped");
    expect(prompt).not.toContain("error");
  });

  it("reports a finished plan's result, not a later chat reply or a verdict", () => {
    const prompt = reportPrompt({
      summary: "S",
      steps: [step(1, "done"), step(2, "done")],
      messages: [
        { role: "assistant", content: "Step one done.", planStep: "s1" },
        { role: "assistant", content: "Merged the branch.\nSTEP DONE", planStep: "s2" },
        { role: "assistant", content: "Sure, anything else?" },
      ],
    });
    expect(prompt).toContain("Outcome: SUCCESS");
    expect(prompt).toContain("Result: Merged the branch.");
    expect(prompt).not.toContain("anything else");
    expect(prompt).not.toMatch(/STEP DONE/i);
  });

  it("says when the user stopped it and how the run failed", () => {
    const prompt = reportPrompt({
      summary: "S",
      steps: [step(1, "pending")],
      messages: [],
      stopped: true,
      error: "Couldn't reach the server",
    });
    expect(prompt).toContain("The user stopped the plan.");
    expect(prompt).toContain("The run ended with this error: Couldn't reach the server");
    expect(prompt).toContain("1. Do thing 1: not run");
    expect(prompt).not.toContain("What the user asked for");
    expect(prompt).toContain("Outcome: NOT FINISHED");
  });

  it("shortens a step's note in the steps list but gives the plan's result whole", () => {
    const last = "y ".repeat(5000).trim();
    const prompt = reportPrompt({
      summary: "S",
      steps: [step(1, "done", { note: "x".repeat(5000) })],
      messages: [{ role: "assistant", content: last, planStep: "s1" }],
    });
    expect(prompt).toContain("1. Do thing 1: done (" + "x".repeat(200) + "…)");
    expect(prompt).toContain(`Result: ${last}`);
  });
});

describe("parseReport", () => {
  it("keeps all of it, line breaks included", () => {
    const text = "It did A. It did B. It did C.\nFollow-up: restart the server.";
    expect(parseReport(text)).toBe(text);
  });

  it("tidies spaces, blank lines, a label and quotes", () => {
    expect(parseReport('  Report: "It  worked.  \n\n\n\nFollow-up: restart the server."  ')).toBe(
      "It worked.\n\nFollow-up: restart the server.",
    );
  });

  it("cuts only an answer longer than the limit, and marks it", () => {
    expect(parseReport("w".repeat(600))).toHaveLength(600);
    const long = parseReport(`${"word ".repeat(400)}end.`)!;
    expect(long.length).toBeLessThanOrEqual(601);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is null when there is nothing in it", () => {
    expect(parseReport("")).toBeNull();
    expect(parseReport(" \n ")).toBeNull();
    expect(parseReport('""')).toBeNull();
  });
});

describe("fallbackReport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("says all done", () => {
    expect(fallbackReport({ steps: [step(1, "done"), step(2, "done")] })).toBe("All 2 steps are done.");
    expect(fallbackReport({ steps: [step(1, "done")] })).toBe("The one step is done.");
  });

  it("names the first step that failed, with its note", () => {
    expect(fallbackReport({ steps: [step(1, "done"), step(2, "failed", { note: "The build broke" }), step(3, "pending")] })).toBe(
      "Step 2 failed. The build broke. Open the thread to see what happened.",
    );
    expect(fallbackReport({ steps: [step(1, "failed")] })).toBe("Step 1 failed. Open the thread to see what happened.");
  });

  it("says a disputed step waits for the user, and a waiting one asked a question", () => {
    expect(fallbackReport({ steps: [step(1, "disputed")] })).toBe(
      "Step 1 didn't pass its check, and it is waiting for you to decide. Open the thread to look at it.",
    );
    expect(fallbackReport({ steps: [step(1, "done"), step(2, "waiting", { note: "Which database?" })] })).toBe(
      "Step 2 stopped to ask you a question. Which database? Answer it in the thread to go on.",
    );
  });

  it("says how far a stopped or interrupted plan got", () => {
    const steps = [step(1, "done"), step(2, "pending"), step(3, "pending")];
    expect(fallbackReport({ steps, stopped: true })).toBe("You paused it after 1 of 3 steps. Continue in the thread to go on.");
    expect(fallbackReport({ steps, error: "Couldn't reach the server" })).toBe(
      "It stopped after 1 of 3 steps. Couldn't reach the server. Continue in the thread to try again.",
    );
    expect(fallbackReport({ steps })).toBe("1 of 3 steps are done, and the plan isn't finished. Continue in the thread to go on.");
  });

  it("copes with no plan", () => {
    expect(fallbackReport({ steps: [] })).toBe("The thread has no plan.");
  });
});
