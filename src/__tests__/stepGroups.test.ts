import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../api";
import { groupRounds } from "../stepGroups";

const call = (id: string, name = "read_file"): ToolCall => ({ id, name, arguments: "{}" });
const assistant = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", content: "", ...extra });
const tool = (id: string): ChatMessage => ({ role: "tool", content: "ok", toolCallId: id });
const joins = (parts: ChatMessage[]) => groupRounds(parts).map((g) => g.joinsPrevious);

describe("groupRounds", () => {
  it("returns nothing for no rounds", () => {
    expect(groupRounds([])).toEqual([]);
  });

  it("keeps every round apart when each has a note", () => {
    const parts = [
      assistant({ content: "Looking", toolCalls: [call("1")] }),
      assistant({ content: "Now this", toolCalls: [call("2")] }),
      assistant({ content: "Done" }),
    ];
    expect(joins(parts)).toEqual([false, false, false]);
  });

  it("joins one note-less round to the steps before it", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1")] }), assistant({ toolCalls: [call("2")] }), assistant({ content: "Done" })];
    expect(joins(parts)).toEqual([false, true, false]);
  });

  it("joins three note-less rounds in a row into the first row", () => {
    const parts = [
      assistant({ content: "Looking", toolCalls: [call("1")] }),
      assistant({ toolCalls: [call("2")] }),
      assistant({ toolCalls: [call("3")] }),
      assistant({ toolCalls: [call("4")] }),
    ];
    expect(joins(parts)).toEqual([false, true, true, true]);
  });

  it("treats a round whose text is only spaces as note-less", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1")] }), assistant({ content: " \n ", toolCalls: [call("2")] })];
    expect(joins(parts)).toEqual([false, true]);
  });

  it("lets a leading note-less round start its own row, and the next note-less one join it", () => {
    const parts = [assistant({ toolCalls: [call("1")] }), assistant({ toolCalls: [call("2")] }), assistant({ content: "Then", toolCalls: [call("3")] })];
    expect(joins(parts)).toEqual([false, true, false]);
  });

  it("starts a new row at a round with a note after a joined group", () => {
    const parts = [
      assistant({ content: "A", toolCalls: [call("1")] }),
      assistant({ toolCalls: [call("2")] }),
      assistant({ content: "B", toolCalls: [call("3")] }),
      assistant({ toolCalls: [call("4")] }),
    ];
    expect(joins(parts)).toEqual([false, true, false, true]);
  });

  it("joins a note-less round that only has thinking to the row above it", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1")] }), assistant({ reasoning: "hmm" })];
    expect(joins(parts)).toEqual([false, true]);
  });

  it("does not join a round with no steps at all", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1")] }), assistant()];
    expect(joins(parts)).toEqual([false, false]);
  });

  it("does not join a final answer with text", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1")] }), assistant({ reasoning: "hmm", content: "Here it is" })];
    expect(joins(parts)).toEqual([false, false]);
  });

  it("does not join a thinking-only round that has a note, and nothing joins after a round with no calls", () => {
    const parts = [
      assistant({ content: "Looking", toolCalls: [call("1")] }),
      assistant({ reasoning: "hmm", content: "Almost there" }),
      assistant({ toolCalls: [call("2")] }),
    ];
    expect(joins(parts)).toEqual([false, false, false]);
  });

  it("does not join a thinking-only round that comes first", () => {
    expect(joins([assistant({ reasoning: "hmm" })])).toEqual([false]);
  });

  it("does not count note tools as steps", () => {
    const parts = [assistant({ content: "Looking", toolCalls: [call("1")] }), assistant({ toolCalls: [call("2", "add_idea")] })];
    expect(joins(parts)).toEqual([false, false]);
  });

  it("skips tool result messages and returns the assistant rounds", () => {
    const first = assistant({ content: "Looking", toolCalls: [call("1")] });
    const second = assistant({ toolCalls: [call("2")] });
    const groups = groupRounds([first, tool("1"), second, tool("2")]);
    expect(groups).toEqual([
      { round: first, joinsPrevious: false },
      { round: second, joinsPrevious: true },
    ]);
  });
});
