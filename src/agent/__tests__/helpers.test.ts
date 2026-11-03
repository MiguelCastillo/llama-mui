import { describe, it, expect } from "vitest";
import { type ChatMessage, type ToolCall } from "../../api";
import { shareTokens, callKey, commandSummary, INTERRUPTED, failureLine } from "../helpers";

// ── shareTokens ─────────────────────────────────────────────────────────────

describe("shareTokens", () => {
  function msg(content: string): ChatMessage {
    return { role: "user", content };
  }

  it("distributes tokens proportionally by content length", () => {
    const history: ChatMessage[] = [
      msg("hi"),            // 2 chars
      msg("hello world"),   // 11 chars
      msg("foo"),           // 3 chars
    ];
    const result = shareTokens(history, [0, 1, 2], 160);
    // Total chars = 16. Proportions: 2/16, 11/16, 3/16.
    // Tokens: 20, 110, 30 (round to nearest integer).
    expect(result[0].stats?.tokens).toBe(20);
    expect(result[1].stats?.tokens).toBe(110);
    expect(result[2].stats?.tokens).toBe(30);
  });

  it("only updates messages at the given indexes", () => {
    const history: ChatMessage[] = [msg("a"), msg("b"), msg("c")];
    const result = shareTokens(history, [1], 100);
    expect(result[0].stats).toBeUndefined();
    expect(result[1].stats?.tokens).toBe(100);
    expect(result[2].stats).toBeUndefined();
  });

  it("preserves existing stats on other messages", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "a", stats: { ms: 10, tokens: 5 } },
      { role: "user", content: "bb", stats: { ms: 20, tokens: 10 } },
    ];
    const result = shareTokens(history, [1], 50);
    expect(result[0].stats?.tokens).toBe(5); // unchanged
    expect(result[1].stats?.tokens).toBe(50); // updated
  });

  it("handles zero total chars by giving zero tokens", () => {
    const history: ChatMessage[] = [msg(""), msg(""), msg("")];
    const result = shareTokens(history, [0, 1, 2], 99);
    // All zero chars → chars=1 (fallback), but 0*99/1 = 0 for each.
    expect(result[0].stats?.tokens).toBe(0);
    expect(result[1].stats?.tokens).toBe(0);
    expect(result[2].stats?.tokens).toBe(0);
  });

  it("returns a new array (does not mutate input)", () => {
    const history: ChatMessage[] = [msg("a"), msg("b")];
    const result = shareTokens(history, [0], 100);
    expect(result).not.toBe(history);
    expect(history[0].stats).toBeUndefined();
  });
});

// ── callKey ─────────────────────────────────────────────────────────────────

describe("callKey", () => {
  function toolCall(name: string, args: object): ToolCall {
    return { name, arguments: JSON.stringify(args), id: "x" };
  }

  it("returns tool name and normalized JSON arguments", () => {
    const key = callKey(toolCall("read_file", { path: "src/foo.ts" }));
    expect(key).toBe("read_file {\"path\":\"src/foo.ts\"}");
  });

  it("normalizes argument order via parse+stringify", () => {
    const a = callKey(toolCall("write_file", { path: "a.txt", content: "hi" }));
    const b = callKey(toolCall("write_file", { path: "a.txt", content: "hi" }));
    // Same object shape → same key regardless of insertion order in the
    // original JSON (parse+stringify normalizes).
    expect(a).toBe(b);
  });

  it("falls back to raw arguments on invalid JSON", () => {
    const call: ToolCall = { name: "run_command", arguments: "not json at all", id: "x" };
    const key = callKey(call);
    expect(key).toBe("run_command not json at all");
  });

  it("treats different tool names as different keys", () => {
    const a = callKey(toolCall("read_file", { path: "a.txt" }));
    const b = callKey(toolCall("write_file", { path: "a.txt" }));
    expect(a).not.toBe(b);
  });
});

// ── commandSummary ──────────────────────────────────────────────────────────

describe("commandSummary", () =>
{
  it("skips the $ command line and the exit code line", () => {
    const output = "$ ls\nfile1\nfile2\n[exit code 0]";
    expect(commandSummary(output)).toBe("file1 file2");
  });

  it("filters out blank lines", () => {
    const output = "$ echo hi\n\nhello\n\n[exit code 0]";
    expect(commandSummary(output)).toBe("hello");
  });

  it("returns '(no output)' when only $ and exit code lines exist", () => {
    const output = "$ ls\n[exit code 0]";
    expect(commandSummary(output)).toBe("(no output)");
  });

  it("truncates to 200 characters with ellipsis", () => {
    const longLine = "x".repeat(300);
    const output = `$ cmd\n${longLine}\n[exit code 0]`;
    const summary = commandSummary(output);
    expect(summary.length).toBe(201); // 200 chars + "…"
    expect(summary.endsWith("…")).toBe(true);
  });

  it("joins at most two lines", () => {
    const output = "$ cmd\nline1\nline2\nline3\n[exit code 0]";
    expect(commandSummary(output)).toBe("line1 line2");
  });
});

// ── INTERRUPTED ─────────────────────────────────────────────────────────────

describe("INTERRUPTED", () => {
  it("equals 'interrupted'", () => {
    expect(INTERRUPTED).toBe("interrupted");
  });
});

// ── failureLine ─────────────────────────────────────────────────────────────

describe("failureLine", () => {
  it("returns a message for INTERRUPTED", () => {
    expect(failureLine(INTERRUPTED)).toBe("The reply was cut off.");
  });

  it("returns a message for TypeError", () => {
    expect(failureLine("TypeError: fetch failed")).toBe("Couldn't reach the llama server.");
  });

  it("returns a message for 502 errors", () => {
    expect(failureLine("Server error: 502 Bad Gateway")).toBe("Couldn't reach the llama server.");
  });

  it("returns a generic error message for other failures", () => {
    expect(failureLine("Something went wrong")).toBe("The llama server returned an error.");
  });

  it("handles empty string", () => {
    expect(failureLine("")).toBe("The llama server returned an error.");
  });

  it("names the connector that rejected a 400", () => {
    const err = "Error: POST /v1/messages: 400 messages.3: tool_use ids were found without tool_result blocks";
    expect(failureLine(err, "Anthropic")).toBe(
      "Anthropic rejected the request: messages.3: tool_use ids were found without tool_result blocks",
    );
  });

  it("falls back to the llama server for a 400 without a name", () => {
    expect(failureLine("Error: POST /v1/chat/completions: 400 bad thing")).toBe(
      "The llama server rejected the request: bad thing",
    );
  });

  it("cuts a long rejection message to about 160 characters", () => {
    const line = failureLine(`Error: POST /v1/messages: 400 ${"x".repeat(400)}`, "Anthropic");
    expect(line).toBe(`Anthropic rejected the request: ${"x".repeat(160)}…`);
  });

  it("does not cut a message of exactly 160 characters", () => {
    const line = failureLine(`Error: POST /v1/messages: 400 ${"y".repeat(160)}`, "Anthropic");
    expect(line).toBe(`Anthropic rejected the request: ${"y".repeat(160)}`);
  });

  it("collapses whitespace in the rejection message", () => {
    expect(failureLine("Error: POST /v1/messages: 400 line one\n  line two", "Anthropic")).toBe(
      "Anthropic rejected the request: line one line two",
    );
  });

  it("says it couldn't reach the named connector on a 502", () => {
    expect(failureLine("Error: POST /v1/messages: 502 Bad Gateway", "Work llama")).toBe("Couldn't reach Work llama.");
  });

  it("says it couldn't reach the named connector on a TypeError", () => {
    expect(failureLine("TypeError: fetch failed", "Anthropic")).toBe("Couldn't reach Anthropic.");
  });

  it("keeps the cut-off line for an interrupted reply whatever the name", () => {
    expect(failureLine(INTERRUPTED, "Anthropic")).toBe("The reply was cut off.");
  });

  it("names the connector in the fallback", () => {
    expect(failureLine("Something went wrong", "anthropic")).toBe("Anthropic returned an error.");
  });

  it("uses the default name when the connector name is blank", () => {
    expect(failureLine("Error: POST /v1/messages: 400 nope", "  ")).toBe("The llama server rejected the request: nope");
  });
});
