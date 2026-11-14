import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../api";
import { liveLine } from "../liveLine";

const call = (id: string, name = "read_file", args = "{}"): ToolCall => ({ id, name, arguments: args });
const assistant = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", content: "", ...extra });
const done = (...ids: string[]) => (id: string) => ids.includes(id);

describe("liveLine", () => {
  it("names the running call when Show steps is on", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1", "read_file", '{"path":"src/a.ts"}')] })];
    expect(liveLine(parts, { showCalls: true, hasResult: done() })).toEqual({
      text: "Running read_file src/a.ts",
      writingAnswer: false,
    });
  });

  it("says Working… instead of naming the call when Show steps is off", () => {
    const parts = [assistant({ toolCalls: [call("1", "run_command", '{"command":"ls"}')] })];
    expect(liveLine(parts, { showCalls: false, hasResult: done() }).text).toBe("Working…");
  });

  it("names the first call that has no result yet", () => {
    const parts = [assistant({ toolCalls: [call("1", "read_file", '{"path":"a"}'), call("2", "read_file", '{"path":"b"}')] })];
    expect(liveLine(parts, { showCalls: true, hasResult: done("1") }).text).toBe("Running read_file b");
  });

  it("says Thinking… between rounds, when every call has its result and the newest round is empty", () => {
    const parts = [assistant({ toolCalls: [call("1")] }), assistant()];
    expect(liveLine(parts, { showCalls: true, hasResult: done("1") }).text).toBe("Thinking…");
  });

  it("says Thinking… when the newest round is only thinking", () => {
    expect(liveLine([assistant({ reasoning: "hmm" })]).text).toBe("Thinking…");
  });

  it("says Writing… while the newest round has text and no calls yet, and flags it", () => {
    const parts = [assistant({ toolCalls: [call("1")] }), assistant({ content: "Here is what I found" })];
    expect(liveLine(parts, { hasResult: done("1") })).toEqual({ text: "Writing…", writingAnswer: true });
  });

  it("does not repeat text already in the chat", () => {
    const parts = [assistant({ content: "Looking at the config", toolCalls: [call("1")] }), assistant()];
    expect(liveLine(parts, { hasResult: done("1") }).text).toBe("Thinking…");
  });

  it("does not count a whitespace-only round as writing", () => {
    expect(liveLine([assistant({ content: " \n" })])).toEqual({ text: "Thinking…", writingAnswer: false });
  });

  it("handles an empty reply", () => {
    expect(liveLine([])).toEqual({ text: "Thinking…", writingAnswer: false });
  });

  it("shows the last line of a thinking summary when the connection's reasoning is a summary", () => {
    const parts = [assistant({ reasoning: "**Plan**\nCheck the config first.\n" })];
    expect(liveLine(parts, { reasoningIsSummary: true })).toEqual({ text: "Check the config first.", writingAnswer: false });
  });

  it("never shows raw thoughts", () => {
    expect(liveLine([assistant({ reasoning: "Let me think about this..." })], { reasoningIsSummary: false }).text).toBe("Thinking…");
  });
});
