import { describe, it, expect } from "vitest";
import { type ChatMessage, type PlanStep } from "../../api";
import { planFromCall, stepPrompt, filesChanged, weighDispute, extractContext } from "../plan";

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
