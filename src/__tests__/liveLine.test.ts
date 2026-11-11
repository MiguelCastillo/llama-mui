import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../api";
import { liveLine } from "../liveLine";

const call = (id: string, name = "read_file"): ToolCall => ({ id, name, arguments: "{}" });
const assistant = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", content: "", ...extra });
const tool = (id: string): ChatMessage => ({ role: "tool", content: "ok", toolCallId: id });

describe("liveLine", () => {
  it("says Thinking… when no round has a note yet", () => {
    const parts = [assistant({ toolCalls: [call("1")] })];
    expect(liveLine(parts)).toEqual({ text: "Thinking…", writingAnswer: false });
  });

  it("shows the note of the newest round", () => {
    const parts = [
      assistant({ content: "Looking at the config", toolCalls: [call("1")] }),
      tool("1"),
      assistant({ content: "  Now the tests \n", toolCalls: [call("2")] }),
    ];
    expect(liveLine(parts)).toEqual({ text: "Now the tests", writingAnswer: false });
  });

  it("keeps an earlier note when the newest round has none", () => {
    const parts = [assistant({ content: "Looking at the config", toolCalls: [call("1")] }), tool("1"), assistant({ toolCalls: [call("2")] })];
    expect(liveLine(parts)).toEqual({ text: "Looking at the config", writingAnswer: false });
  });

  it("keeps an earlier note when the newest round is only thinking", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1")] }), tool("1"), assistant({ reasoning: "hmm" })];
    expect(liveLine(parts)).toEqual({ text: "Looking", writingAnswer: false });
  });

  it("says Thinking… when the only round is thinking", () => {
    expect(liveLine([assistant({ reasoning: "hmm" })])).toEqual({ text: "Thinking…", writingAnswer: false });
  });

  it("flags the final answer streaming and keeps the last note", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1")] }), tool("1"), assistant({ content: "Here is what I found" })];
    expect(liveLine(parts)).toEqual({ text: "Looking", writingAnswer: true });
  });

  it("flags an answer that is the first and only round", () => {
    expect(liveLine([assistant({ content: "Hello" })])).toEqual({ text: "Thinking…", writingAnswer: true });
  });

  it("does not count a whitespace-only round as the answer", () => {
    expect(liveLine([assistant({ content: " \n" })])).toEqual({ text: "Thinking…", writingAnswer: false });
  });

  it("handles an empty reply", () => {
    expect(liveLine([])).toEqual({ text: "Thinking…", writingAnswer: false });
  });

  it("shows the last line of a thinking summary when its connection says reasoning is a summary, and no note exists", () => {
    const parts = [assistant({ reasoning: "**Plan**\nCheck the config first.\n" })];
    expect(liveLine(parts, true)).toEqual({ text: "Check the config first.", writingAnswer: false });
  });

  it("never shows raw thoughts, and prefers a note over a summary", () => {
    const raw = [assistant({ reasoning: "Let me think about this..." })];
    expect(liveLine(raw, false).text).toBe("Thinking…");
    const noted = [assistant({ content: "Reading the config", reasoning: "summary", toolCalls: [call("1")] })];
    expect(liveLine(noted, true).text).toBe("Reading the config");
  });
});
