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
    { role: "assistant", content: "First answer" },
    { role: "assistant", content: "I changed a.ts and b.ts." },
    { role: "assistant", content: "   " },
  ];

  it("asks for one or two plain sentences and names what was asked, the plan and each step", () => {
    const prompt = reportPrompt({
      summary: "Do two things",
      request: "Please do two things",
      steps: [step(1, "done"), step(2, "failed", { note: "npm test failed" })],
      messages,
    });
    expect(prompt).toMatch(/one or two plain sentences/);
    expect(prompt).toMatch(/what went wrong and what the user needs to do/);
    expect(prompt).toContain("What the user asked for:\nPlease do two things");
    expect(prompt).toContain("The plan: Do two things");
    expect(prompt).toContain("1. Do thing 1: done");
    expect(prompt).toContain("2. Do thing 2: failed (npm test failed)");
    // The model's last words, not an empty message after them.
    expect(prompt).toContain("The last thing the model said in the thread:\nI changed a.ts and b.ts.");
    expect(prompt).not.toContain("The user stopped");
    expect(prompt).not.toContain("error");
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
    expect(prompt).not.toContain("The last thing");
  });

  it("keeps long text short", () => {
    const prompt = reportPrompt({
      summary: "S",
      steps: [step(1, "failed", { note: "x".repeat(5000) })],
      messages: [{ role: "assistant", content: "y".repeat(10_000) }],
    });
    expect(prompt.length).toBeLessThan(2500);
  });
});

describe("parseReport", () => {
  it("keeps the first two sentences", () => {
    expect(parseReport("It did A. It did B. It did C.")).toBe("It did A. It did B.");
    expect(parseReport("Only one.")).toBe("Only one.");
    expect(parseReport("Did it! Really?  Yes.")).toBe("Did it! Really?");
  });

  it("doesn't end a sentence at a dot inside a file name or number", () => {
    expect(parseReport('The file was created successfully. The file out.txt contains "echo" to complete the task.')).toBe(
      'The file was created successfully. The file out.txt contains "echo" to complete the task.',
    );
    expect(parseReport("Updated to v1.2 and notes.txt. Then it stopped. Extra.")).toBe("Updated to v1.2 and notes.txt. Then it stopped.");
    expect(parseReport("Wrote a.txt and b.txt")).toBe("Wrote a.txt and b.txt");
  });

  it("tidies whitespace, a label and quotes", () => {
    expect(parseReport('  Report: "It worked.\n\nAll good."  ')).toBe("It worked. All good.");
  });

  it("keeps an answer with no full stop, and cuts a very long one", () => {
    expect(parseReport("It worked")).toBe("It worked");
    const long = parseReport(`${"word ".repeat(200)}end.`)!;
    expect(long.length).toBeLessThanOrEqual(401);
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
    expect(fallbackReport({ steps, stopped: true })).toBe("You stopped it after 1 of 3 steps. Continue in the thread to go on.");
    expect(fallbackReport({ steps, error: "Couldn't reach the server" })).toBe(
      "It stopped after 1 of 3 steps. Couldn't reach the server. Continue in the thread to try again.",
    );
    expect(fallbackReport({ steps })).toBe("1 of 3 steps are done, and the plan isn't finished. Continue in the thread to go on.");
  });

  it("copes with no plan", () => {
    expect(fallbackReport({ steps: [] })).toBe("The thread has no plan.");
  });
});
