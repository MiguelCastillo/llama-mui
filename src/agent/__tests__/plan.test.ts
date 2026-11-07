import { describe, it, expect, vi } from "vitest";

const { mockStreamChat } = vi.hoisted(() => ({ mockStreamChat: vi.fn() }));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, streamChat: mockStreamChat };
});

import { type ChatMessage, type PlanStep } from "../../api";
import {
  reviewStep,
  planFromCall,
  stepPrompt,
  filesChanged,
  weighDispute,
  extractContext,
  extractPlanSummary,
  stepLine,
  parseQuestion,
  recoveryPrompt,
  stepOutput,
  REVIEW_PROMPT,
} from "../plan";

// ── summaries ───────────────────────────────────────────────────────────────

describe("planFromCall summaries", () => {
  it("keeps each step's summary, trimmed", () => {
    const args = JSON.stringify({
      steps: [
        { text: "Do A", summary: "  Make A  " },
        { text: "Do B", summary: "Make B" },
      ],
    });
    const result = planFromCall(args, [], false);
    expect(result!.map((s) => s.summary)).toEqual(["Make A", "Make B"]);
  });

  it("leaves the summary out when the step has none", () => {
    const result = planFromCall(JSON.stringify({ steps: ["Do A", { text: "Do B", summary: "  " }] }), [], false);
    expect(result!.every((s) => !("summary" in s))).toBe(true);
  });

  it("takes the new summary for a step that matches by text", () => {
    const old: PlanStep[] = [{ id: "s1", text: "Do A", summary: "Old line", status: "done" }];
    const result = planFromCall(JSON.stringify({ steps: [{ text: "Do A", summary: "New line" }] }), old, false);
    expect(result).toEqual([{ id: "s1", text: "Do A", summary: "New line", status: "done" }]);
  });

  it("keeps the old summary when the call gives none", () => {
    const old: PlanStep[] = [{ id: "s1", text: "Do A", summary: "Old line", status: "done" }];
    const result = planFromCall(JSON.stringify({ steps: ["Do A"] }), old, false);
    expect(result![0].summary).toBe("Old line");
  });

  it("gives a reworded running step its new summary and keeps its id", () => {
    const old: PlanStep[] = [{ id: "s1", text: "Do A", summary: "Old line", status: "running" }];
    const result = planFromCall(JSON.stringify({ steps: [{ text: "Do A better", summary: "Better line" }] }), old, true);
    expect(result).toEqual([{ id: "s1", text: "Do A better", summary: "Better line", status: "running" }]);
  });
});

describe("stepLine", () => {
  it("is the summary when there is one", () => {
    expect(stepLine({ text: "A long instruction for the model", summary: "Make a stuck step retry" })).toBe(
      "Make a stuck step retry",
    );
  });

  it("is the whole text for a short step without a summary", () => {
    expect(stepLine({ text: "Add the field" })).toBe("Add the field");
    expect(stepLine({ text: "Add the field", summary: "  " })).toBe("Add the field");
  });

  it("is the whole long text for an old step without a summary, with no ellipsis", () => {
    const text = "word ".repeat(40).trim();
    const line = stepLine({ text });
    expect(line).toBe(text);
    expect(line.length).toBeGreaterThan(70);
    expect(line).not.toContain("…");
  });

  it("joins a text's lines into one", () => {
    expect(stepLine({ text: "First line\n  second line" })).toBe("First line second line");
  });
});

describe("extractPlanSummary", () => {
  it("returns the trimmed summary", () => {
    expect(extractPlanSummary(JSON.stringify({ steps: [], summary: "  Adds summaries  " }))).toBe("Adds summaries");
  });

  it("returns null when it is missing, empty, not a string or the args aren't JSON", () => {
    expect(extractPlanSummary(JSON.stringify({ steps: [] }))).toBeNull();
    expect(extractPlanSummary(JSON.stringify({ summary: "   " }))).toBeNull();
    expect(extractPlanSummary(JSON.stringify({ summary: 5 }))).toBeNull();
    expect(extractPlanSummary("not json")).toBeNull();
  });
});

// ── planFromCall ────────────────────────────────────────────────────────────

describe("planFromCall", () => {
  it("returns null when args is not valid JSON", () => {
    expect(planFromCall("not json", [], false)).toBeNull();
  });

  it("returns null when parsed JSON has no steps array", () => {
    expect(planFromCall('{"foo": "bar"}', [], false)).toBeNull();
  });

  it("returns null when steps is not an array", () => {
    expect(planFromCall('{"steps": "not an array"}', [], false)).toBeNull();
  });

  it("converts string steps to PlanStep objects", () => {
    const args = JSON.stringify({ steps: ["Do A", "Do B"] });
    const result = planFromCall(args, [], false);
    expect(result).toEqual([
      { id: expect.any(String), text: "Do A", status: "pending" },
      { id: expect.any(String), text: "Do B", status: "pending" },
    ]);
  });

  it("preserves existing step id and status when running and same position", () => {
    const old: PlanStep[] = [
      { id: "step-1", text: "Do A", status: "running" },
      { id: "step-2", text: "Do B", status: "pending" },
    ];
    const args = JSON.stringify({ steps: ["Do A", "Do B"] });
    const result = planFromCall(args, old, true);
    expect(result).toEqual([
      { id: "step-1", text: "Do A", status: "running" },
      { id: "step-2", text: "Do B", status: "pending" },
    ]);
  });

  it("finds matching step by text when not running", () => {
    const old: PlanStep[] = [
      { id: "step-1", text: "Do A", status: "done" },
      { id: "step-2", text: "Do B", status: "pending" },
    ];
    const args = JSON.stringify({ steps: ["Do B", "Do C"] });
    const result = planFromCall(args, old, false);
    expect(result).toEqual([
      { id: "step-2", text: "Do B", status: "pending" },
      { id: expect.any(String), text: "Do C", status: "pending" },
    ]);
  });

  it("trims whitespace from step text", () => {
    const args = JSON.stringify({ steps: ["  Do A  "] });
    const result = planFromCall(args, [], false);
    expect(result![0].text).toBe("Do A");
  });

  it("handles object steps with text property", () => {
    const args = JSON.stringify({ steps: [{ text: "Do A" }, "Do B"] });
    const result = planFromCall(args, [], false);
    expect(result).toEqual([
      { id: expect.any(String), text: "Do A", status: "pending" },
      { id: expect.any(String), text: "Do B", status: "pending" },
    ]);
  });

  it("generates unique ids for each step", () => {
    const args = JSON.stringify({ steps: ["A", "B", "C"] });
    const result = planFromCall(args, [], false);
    const ids = result!.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("gives a plan that drops its done steps the running step first, then pending steps", () => {
    // Old plan: 9 steps, 3 done, step 4 running, steps 5-9 pending. The model
    // sends the work left, its first step the running one reworded.
    const old: PlanStep[] = [
      { id: "s1", text: "Old step 1", status: "done" },
      { id: "s2", text: "Old step 2", status: "done" },
      { id: "s3", text: "Old step 3", status: "done" },
      { id: "s4", text: "Old step 4", status: "running" },
      { id: "s5", text: "Old step 5", status: "pending" },
      { id: "s6", text: "Old step 6", status: "pending" },
      { id: "s7", text: "Old step 7", status: "pending" },
      { id: "s8", text: "Old step 8", status: "pending" },
      { id: "s9", text: "Old step 9", status: "pending" },
    ];
    const args = JSON.stringify({
      steps: ["New remaining 1", "New remaining 2", "New remaining 3"],
    });
    const result = planFromCall(args, old, true);
    expect(result!.map((s) => [s.id === "s4" ? "s4" : "new", s.status])).toEqual([
      ["s4", "running"],
      ["new", "pending"],
      ["new", "pending"],
    ]);
    expect(new Set(result!.map((s) => s.id)).size).toBe(3);
  });

  it("preserves running step id and status when it is reworded and at its old position", () => {
    // The running step is at index 2 in both old and new; text changed.
    const old: PlanStep[] = [
      { id: "s1", text: "Step one", status: "done" },
      { id: "s2", text: "Step two", status: "done" },
      { id: "s3", text: "Do the hard part", status: "running" },
      { id: "s4", text: "After that", status: "pending" },
    ];
    const args = JSON.stringify({
      steps: ["Step one", "Step two", "Tweaked the hard part", "After that"],
    });
    const result = planFromCall(args, old, true);
    // The reworded running step keeps its id and status.
    expect(result![2].id).toBe("s3");
    expect(result![2].status).toBe("running");
    // The step matching "After that" by text keeps its id/status.
    expect(result![3].id).toBe("s4");
    expect(result![3].status).toBe("pending");
  });
});

// ── extractContext ──────────────────────────────────────────────────────────

describe("extractContext", () => {
  it("returns the context string when present", () => {
    const args = JSON.stringify({ steps: ["Do A"], context: "Some background" });
    expect(extractContext(args)).toBe("Some background");
  });

  it("returns null when context is missing", () => {
    const args = JSON.stringify({ steps: ["Do A"] });
    expect(extractContext(args)).toBeNull();
  });

  it("returns null when context is explicitly null", () => {
    const args = JSON.stringify({ steps: ["Do A"], context: null });
    expect(extractContext(args)).toBeNull();
  });

  it("returns null when args is not valid JSON", () => {
    expect(extractContext("not json")).toBeNull();
  });

  it("trims whitespace from the context string", () => {
    const args = JSON.stringify({ steps: ["Do A"], context: "  Some background  " });
    expect(extractContext(args)).toBe("Some background");
  });

  it("returns null for an empty string context", () => {
    const args = JSON.stringify({ steps: ["Do A"], context: "" });
    expect(extractContext(args)).toBeNull();
  });

  it("returns null for a whitespace-only context", () => {
    const args = JSON.stringify({ steps: ["Do A"], context: "   \n\t  " });
    expect(extractContext(args)).toBeNull();
  });

  it("returns null when context is not a string", () => {
    const args = JSON.stringify({ steps: ["Do A"], context: 42 });
    expect(extractContext(args)).toBeNull();
  });
});

// ── stepPrompt ──────────────────────────────────────────────────────────────

describe("stepPrompt", () => {
  it("produces a prompt with the step text and plan context", () => {
    const steps: PlanStep[] = [
      { id: "1", text: "Do A", status: "done" },
      { id: "2", text: "Do B", status: "pending" },
      { id: "3", text: "Do C", status: "pending" },
    ];
    const prompt = stepPrompt(steps, 1);
    expect(prompt).toContain("Do step 2 of 3: Do B");
    expect(prompt).toContain("The plan:");
    expect(prompt).toContain("[x] 1. Do A");
    expect(prompt).toContain("[ ] 2. Do B");
    expect(prompt).toContain("[ ] 3. Do C");
    // "Do step N" must be the last line of the prompt.
    expect(prompt.split("\n").pop()?.trim()).toBe("Do step 2 of 3: Do B");
  });

  it("uses [ ] for pending steps", () => {
    const steps: PlanStep[] = [
      { id: "1", text: "Step 1", status: "pending" },
    ];
    const prompt = stepPrompt(steps, 0);
    expect(prompt).toContain("[ ] 1. Step 1");
  });

  it("uses [x] for done steps", () => {
    const steps: PlanStep[] = [
      { id: "1", text: "Step 1", status: "done" },
    ];
    const prompt = stepPrompt(steps, 0);
    expect(prompt).toContain("[x] 1. Step 1");
  });

  it("includes context when provided", () => {
    const steps: PlanStep[] = [
      { id: "1", text: "Step 1", status: "pending" },
    ];
    const prompt = stepPrompt(steps, 0, undefined, undefined, "Remember the auth flow");
    expect(prompt).toContain("What the steps need from the conversation:\nRemember the auth flow");
  });

  it("omits context section when context is null or empty", () => {
    const steps: PlanStep[] = [
      { id: "1", text: "Step 1", status: "pending" },
    ];
    const prompt = stepPrompt(steps, 0, undefined, undefined, null);
    expect(prompt).not.toContain("What the steps need from the conversation:");
  });

  it("passes on the user's answer and the question it answers, before the Do step line", () => {
    const steps: PlanStep[] = [
      { id: "1", text: "Merge x into main", status: "done" },
      {
        id: "2",
        text: "Merge y into main",
        status: "pending",
        asked: "Discard or stash your edit?",
        answer: "stash it",
      },
      { id: "3", text: "Delete the branch", status: "pending" },
    ];
    const prompt = stepPrompt(steps, 1);
    expect(prompt).toContain("You asked: Discard or stash your edit?");
    expect(prompt).toContain("The user answered your question: stash it");
    expect(prompt.indexOf("You asked:")).toBeLessThan(prompt.indexOf("The user answered"));
    expect(prompt.indexOf("The user answered")).toBeLessThan(prompt.indexOf("Do step 2 of 3"));
    expect(prompt.split("\n").pop()?.trim()).toBe("Do step 2 of 3: Merge y into main");
  });

  it("tells the last step, and only the last, to give a short result and a Follow-up line only if needed", () => {
    const steps: PlanStep[] = [
      { id: "1", text: "One", status: "done" },
      { id: "2", text: "Two", status: "pending" },
    ];
    expect(stepPrompt(steps, 0)).not.toContain("Follow-up:");
    const last = stepPrompt(steps, 1);
    expect(last).toContain("This is the last step");
    expect(last).toContain("one or two plain sentences");
    expect(last).toContain('"Follow-up:" only if something must happen after');
    expect(last).not.toContain("Follow-up: none");
    expect(last.indexOf("Do step 2 of 2")).toBeLessThan(last.indexOf("This is the last step"));
  });

  it("gives the answer of the step being run only, not of other steps", () => {
    const steps: PlanStep[] = [
      { id: "1", text: "A", status: "pending", asked: "Q?", answer: "yes" },
      { id: "2", text: "B", status: "pending" },
    ];
    const prompt = stepPrompt(steps, 1);
    expect(prompt).not.toContain("The user answered");
    expect(prompt).not.toContain("You asked");
  });

  it("gives the answer without 'You asked' when the question is unknown", () => {
    const steps: PlanStep[] = [{ id: "1", text: "A", status: "pending", answer: "yes" }];
    const prompt = stepPrompt(steps, 0);
    expect(prompt).toContain("The user answered your question: yes");
    expect(prompt).not.toContain("You asked");
  });

  it("leaves out the answer lines when the step has no answer", () => {
    const steps: PlanStep[] = [{ id: "1", text: "A", status: "waiting", asked: "Q?" }];
    const prompt = stepPrompt(steps, 0);
    expect(prompt).not.toContain("The user answered");
    expect(prompt).not.toContain("You asked");
  });
});

// ── parseQuestion ───────────────────────────────────────────────────────────

describe("parseQuestion", () => {
  it("finds a question on the last line", () => {
    expect(parseQuestion("It is blocked.\nQUESTION: Discard or stash your edit?")).toBe(
      "Discard or stash your edit?",
    );
  });

  it("returns null when there is no QUESTION line", () => {
    expect(parseQuestion("I stashed the edit and reran the merge.")).toBeNull();
    expect(parseQuestion("")).toBeNull();
  });

  it("is case-insensitive and allows leading spaces", () => {
    expect(parseQuestion("  question:   Which branch?  ")).toBe("Which branch?");
  });

  it("uses the last QUESTION line when there are several", () => {
    expect(parseQuestion("QUESTION: first?\nmore text\nQUESTION: second?")).toBe("second?");
  });

  it("only takes the question from its own line", () => {
    expect(parseQuestion("QUESTION: Discard or stash?\nThanks")).toBe("Discard or stash?");
  });

  it("ignores QUESTION in the middle of a line", () => {
    expect(parseQuestion("The QUESTION: is open")).toBeNull();
  });

  it("returns null for QUESTION with nothing after it", () => {
    expect(parseQuestion("QUESTION:   ")).toBeNull();
    // Not the next line either.
    expect(parseQuestion("QUESTION:\nDiscard or stash?")).toBeNull();
  });
});

// ── stepOutput ──────────────────────────────────────────────────────────────

describe("stepOutput", () => {
  const call = (id: string, name: string, args: object): ChatMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  });
  const result = (id: string, content: string): ChatMessage => ({ role: "tool", toolCallId: id, content });

  it("is empty when the step called no tools", () => {
    expect(stepOutput([{ role: "assistant", content: "done" }])).toBe("");
  });

  it("puts each result under the command that made it", () => {
    const out = stepOutput([
      call("c1", "run_command", { command: "git merge --ff-only llama/x" }),
      result("c1", "error: Your local changes would be overwritten"),
    ]);
    expect(out).toBe("$ run_command git merge --ff-only llama/x\nerror: Your local changes would be overwritten");
  });

  it("names the path for file tools and keeps the order of the results", () => {
    const out = stepOutput([
      call("c1", "read_file", { path: "src/a.ts" }),
      result("c1", "contents"),
      call("c2", "run_command", { command: "ls" }),
      result("c2", "a.ts"),
    ]);
    expect(out).toBe("$ read_file src/a.ts\ncontents\n\n$ run_command ls\na.ts");
  });

  it("ignores assistant and user text", () => {
    const out = stepOutput([
      { role: "user", content: "Do step 1" },
      call("c1", "run_command", { command: "pwd" }),
      result("c1", "/tmp"),
      { role: "assistant", content: "All done" },
    ]);
    expect(out).not.toContain("Do step 1");
    expect(out).not.toContain("All done");
    expect(out).toContain("/tmp");
  });

  it("copes with bad arguments and a result without a call", () => {
    const bad: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "run_command", arguments: "not json" }],
    };
    expect(stepOutput([bad, result("c1", "Error: bad arguments"), result("zz", "orphan")])).toBe(
      "$ run_command\nError: bad arguments\n\n$ tool\norphan",
    );
  });
});

// ── REVIEW_PROMPT ───────────────────────────────────────────────────────────

describe("REVIEW_PROMPT", () => {
  it("asks for one short plain sentence after MISSING, about 20 words", () => {
    expect(REVIEW_PROMPT).toContain("MISSING: <one short plain sentence");
    expect(REVIEW_PROMPT).toContain("no more than about 20 words");
  });

  it("says command output counts as evidence", () => {
    expect(REVIEW_PROMPT).toContain("command output shown there counts as evidence");
  });
});

// ── reviewStep: what the commands printed ───────────────────────────────────

describe("reviewStep input", () => {
  const call = (id: string, command: string): ChatMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [{ id, name: "run_command", arguments: JSON.stringify({ command }) }],
  });
  const result = (id: string, content: string): ChatMessage => ({ role: "tool", toolCallId: id, content });

  // Runs the check on a step's turn and returns the user message it was sent.
  async function sentFor(messages: ChatMessage[]): Promise<string> {
    mockStreamChat.mockReset();
    mockStreamChat.mockImplementation(async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
      onDelta({ content: "DONE" });
      return { toolCalls: [] };
    });
    await reviewStep(
      { connectorId: "c", model: "m", think: false, room: 10000, tools: [], read: async () => "" },
      "Do the thing",
      messages,
      [],
      [],
      new AbortController().signal,
    );
    const sent: ChatMessage[] = mockStreamChat.mock.calls[0][0].messages;
    return sent.find((m) => m.role === "user")!.content;
  }

  it("shows what a command printed, before the reply", async () => {
    const text = await sentFor([
      call("c1", "npx vitest run"),
      result("c1", "Tests  12 passed (12)"),
      { role: "assistant", content: "All tests pass" },
    ]);
    expect(text).toContain("What the step's commands and reads printed:\n$ run_command npx vitest run\nTests  12 passed (12)");
    expect(text.indexOf("What the step's commands")).toBeLessThan(text.indexOf("The reply:"));
  });

  it("cuts a long output from the start and keeps the end", async () => {
    const long = "early-line\n" + "x".repeat(5000) + "\nlast-line";
    const text = await sentFor([call("c1", "npm test"), result("c1", long), { role: "assistant", content: "ok" }]);
    // The changes section lists commands too, so look at the printed section only.
    const section = text.slice(text.indexOf("What the step's commands and reads printed:"), text.indexOf("The reply:"));
    expect(section).toContain("(earlier output cut)");
    expect(section).toContain("last-line");
    expect(section).not.toContain("early-line");
    expect(section.length).toBeLessThan(3200);
  });

  it("leaves the section out when the step ran no commands", async () => {
    const text = await sentFor([{ role: "assistant", content: "Read it, nothing to change" }]);
    expect(text).not.toContain("What the step's commands and reads printed");
    expect(text).toContain("The reply:");
  });
});

// ── recoveryPrompt ──────────────────────────────────────────────────────────

describe("recoveryPrompt", () => {
  it("names the step by its number and says what the check says is missing", () => {
    const p = recoveryPrompt(2, "main still lacks the commit", "some output");
    expect(p).toContain("Step 3 is blocked");
    expect(p).toContain("main still lacks the commit");
    expect(p).toContain("some output");
  });

  it("tells the model how to fix it and how to ask", () => {
    const p = recoveryPrompt(0, "x", "out");
    expect(p).toMatch(/safe, reversible/);
    expect(p).toContain("stash");
    expect(p).toContain("do NOT act");
    expect(p).toContain("QUESTION: <one short sentence with the options>");
    expect(p).toContain("one line saying what you changed");
  });

  it("says so when the step printed nothing", () => {
    expect(recoveryPrompt(0, "x", "")).toContain("(nothing)");
  });

  it("keeps all of a short output and does not mark it cut", () => {
    const p = recoveryPrompt(0, "x", "short output");
    expect(p).toContain("short output");
    expect(p).not.toContain("(earlier output cut)");
  });

  it("keeps the end of a long output, not the start, and marks the cut", () => {
    const output = "START-MARK" + "a".repeat(5000) + "END-MARK";
    const p = recoveryPrompt(0, "x", output);
    expect(p).toContain("(earlier output cut)");
    expect(p).toContain("END-MARK");
    expect(p).not.toContain("START-MARK");
    // About 3000 chars of output, not all 5000.
    expect(p.length).toBeLessThan(3000 + 1000);
  });

  it("round-trips: a QUESTION the prompt asks for is found by parseQuestion", () => {
    expect(parseQuestion("QUESTION: Discard or stash?")).toBe("Discard or stash?");
  });
});

// ── filesChanged ────────────────────────────────────────────────────────────

describe("filesChanged", () => {
  function makeToolCall(name: string, id: string, path: string): ChatMessage {
    return {
      role: "assistant",
      content: "",
      toolCalls: [{ name, id, arguments: JSON.stringify({ path }) }],
    };
  }

  function makeToolResult(id: string, content: string): ChatMessage {
    return { role: "tool", content, toolCallId: id };
  }

  it("returns empty array when there are no file changes", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
    expect(filesChanged(messages)).toEqual([]);
  });

  it("returns paths from successful write_file calls", () => {
    const calls = [makeToolCall("write_file", "call-1", "src/foo.ts")];
    const results = [makeToolResult("call-1", "OK")];
    expect(filesChanged([...calls, ...results])).toEqual(["src/foo.ts"]);
  });

  it("returns paths from successful edit_file calls", () => {
    const calls = [makeToolCall("edit_file", "call-1", "src/bar.ts")];
    const results = [makeToolResult("call-1", "OK")];
    expect(filesChanged([...calls, ...results])).toEqual(["src/bar.ts"]);
  });

  it("excludes file changes with Error: results", () => {
    const calls = [makeToolCall("write_file", "call-1", "src/bad.ts")];
    const results = [makeToolResult("call-1", "Error: something went wrong")];
    expect(filesChanged([...calls, ...results])).toEqual([]);
  });

  it("deduplicates paths", () => {
    const calls = [
      makeToolCall("write_file", "call-1", "src/foo.ts"),
      makeToolCall("edit_file", "call-2", "src/foo.ts"),
    ];
    const results = [
      makeToolResult("call-1", "OK"),
      makeToolResult("call-2", "OK"),
    ];
    expect(filesChanged([...calls, ...results])).toEqual(["src/foo.ts"]);
  });

  it("ignores run_command calls", () => {
    const calls = [
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ name: "run_command", id: "call-1", arguments: JSON.stringify({ command: "ls" }) }],
      },
    ];
    const results = [makeToolResult("call-1", "output")];
    expect(filesChanged([...calls, ...results])).toEqual([]);
  });

  it("handles invalid JSON in arguments gracefully", () => {
    const call: ChatMessage = {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ name: "write_file", id: "call-1", arguments: "not json" }],
    };
    const results = [makeToolResult("call-1", "OK")];
    expect(filesChanged([call, ...results])).toEqual([]);
  });
});

// ── weighDispute ────────────────────────────────────────────────────────────

describe("weighDispute", () => {
  function makeToolCall(name: string, id: string, path?: string): ChatMessage {
    const args = path ? JSON.stringify({ path }) : "{}";
    return {
      role: "assistant",
      content: "",
      toolCalls: [{ name, id, arguments: args }],
    };
  }

  function makeToolResult(id: string, content: string): ChatMessage {
    return { role: "tool", content, toolCallId: id };
  }

  function makeAssistant(content: string): ChatMessage {
    return { role: "assistant", content };
  }

  it("returns null verdict when there is no verdict line", () => {
    const messages: ChatMessage[] = [makeAssistant("I read the file and it looks fine.")];
    const step: ChatMessage[] = [];
    const result = weighDispute(messages, step);
    expect(result.verdict).toBeNull();
    expect(result.read).toBe(false);
  });

  it("detects 'STEP NOT DONE' verdict", () => {
    const messages: ChatMessage[] = [makeAssistant("I checked and the step is not done.\n\nSTEP NOT DONE")];
    const step: ChatMessage[] = [];
    const result = weighDispute(messages, step);
    expect(result.verdict).toBe("right");
  });

  it("detects 'STEP DONE' verdict", () => {
    const messages: ChatMessage[] = [makeAssistant("The step is complete.\n\nSTEP DONE")];
    const step: ChatMessage[] = [];
    const result = weighDispute(messages, step);
    expect(result.verdict).toBe("wrong");
  });

  it("uses the last verdict when there are multiple", () => {
    const messages: ChatMessage[] = [
      makeAssistant("STEP DONE\n\nActually, STEP NOT DONE"),
    ];
    const step: ChatMessage[] = [];
    const result = weighDispute(messages, step);
    expect(result.verdict).toBe("right");
  });

  it("detects read_file calls in the step", () => {
    const stepCalls = [makeToolCall("read_file", "call-1", "src/foo.ts")];
    const stepResults = [makeToolResult("call-1", "file content here")];
    const step: ChatMessage[] = [...stepCalls, ...stepResults];
    const messages: ChatMessage[] = [makeAssistant("I read the file.\n\nSTEP DONE")];
    const result = weighDispute(messages, step);
    expect(result.read).toBe(true);
  });

  it("counts quotes from code blocks", () => {
    const messages: ChatMessage[] = [
      makeAssistant(
        "I see this code:\n\n```\nsome_long_line_of_code_here;\n```\n\nSTEP DONE",
      ),
    ];
    const step: ChatMessage[] = [];
    const result = weighDispute(messages, step);
    expect(result.quotes).toBeGreaterThan(0);
  });

  it("detects changed files", () => {
    const stepCalls = [makeToolCall("write_file", "call-1", "src/foo.ts")];
    const stepResults = [makeToolResult("call-1", "OK")];
    const step: ChatMessage[] = [...stepCalls, ...stepResults];
    // The changed flag checks tool calls in `messages` (the retry turn).
    const messages: ChatMessage[] = [
      ...stepCalls,
      makeToolResult("call-1", "OK"),
      makeAssistant("STEP DONE"),
    ];
    const result = weighDispute(messages, step);
    expect(result.changed).toBe(true);
  });

  it("does not count failed tool calls as changed", () => {
    const stepCalls = [makeToolCall("write_file", "call-1", "src/foo.ts")];
    const stepResults = [makeToolResult("call-1", "Error: something went wrong")];
    const step: ChatMessage[] = [...stepCalls, ...stepResults];
    const messages: ChatMessage[] = [makeAssistant("STEP DONE")];
    const result = weighDispute(messages, step);
    expect(result.changed).toBe(false);
  });

  it("extracts reason without verdict line", () => {
    const messages: ChatMessage[] = [
      makeAssistant("The implementation looks correct.\n\nSTEP DONE"),
    ];
    const step: ChatMessage[] = [];
    const result = weighDispute(messages, step);
    expect(result.reason).toContain("implementation looks correct");
    expect(result.reason).not.toContain("STEP DONE");
  });

  it("handles empty messages gracefully", () => {
    const messages: ChatMessage[] = [];
    const step: ChatMessage[] = [];
    const result = weighDispute(messages, step);
    expect(result.verdict).toBeNull();
    expect(result.read).toBe(false);
    expect(result.quotes).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("");
  });
});

describe("stepPrompt for a fresh step", () => {
  it("lists the request and the files earlier steps changed", () => {
    const steps: PlanStep[] = [
      { id: "a", text: "Add fields", status: "done" },
      { id: "b", text: "Use them", status: "pending" },
    ];
    const text = stepPrompt(steps, 1, "Name sessions", ["src/api.ts", "server/chats.ts"]);
    expect(text).toContain("Do step 2 of 2: Use them");
    expect(text).toContain("The task the plan is for:\nName sessions");
    expect(text).toContain("src/api.ts\nserver/chats.ts");
  });

  it("orders context before request before plan before changed files", () => {
    const steps: PlanStep[] = [
      { id: "a", text: "Add fields", status: "done" },
      { id: "b", text: "Use them", status: "pending" },
    ];
    const text = stepPrompt(
      steps,
      1,
      "Name sessions",
      ["src/api.ts"],
      "Background about the session naming",
    );
    const contextIdx = text.indexOf("What the steps need from the conversation:");
    const requestIdx = text.indexOf("The task the plan is for:");
    const planIdx = text.indexOf("The plan:");
    const filesIdx = text.indexOf("Files earlier steps changed;");
    expect(contextIdx).toBeGreaterThan(-1);
    expect(requestIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(requestIdx);
    expect(requestIdx).toBeLessThan(planIdx);
    expect(planIdx).toBeLessThan(filesIdx);
  });
});
