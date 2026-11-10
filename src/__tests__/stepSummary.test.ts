import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../api";
import { stepSummary } from "../stepSummary";

const call = (id: string, name = "read_file"): ToolCall => ({
  id,
  name,
  arguments: "{}",
});
const assistant = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: "assistant",
  content: "",
  ...extra,
});

describe("stepSummary (one round)", () => {
  it("has no steps for a plain answer", () => {
    expect(stepSummary([assistant({ content: "hi" })])).toEqual({ count: 0 });
  });

  it("counts a thinking block", () => {
    expect(
      stepSummary([assistant({ reasoning: "hmm", content: "hi" })]).count,
    ).toBe(1);
  });

  it("counts several tool calls", () => {
    const part = assistant({ toolCalls: [call("1"), call("2"), call("3")] });
    expect(stepSummary([part])).toEqual({ count: 3 });
  });

  it("adds the thinking block to the tool calls of the same round", () => {
    const part = assistant({
      reasoning: "a",
      toolCalls: [call("1"), call("2")],
    });
    expect(stepSummary([part]).count).toBe(3);
  });

  it("does not count note tools, which show as boxes", () => {
    const part = assistant({
      toolCalls: [call("1"), call("2", "add_idea")],
      content: "x",
    });
    expect(stepSummary([part])).toEqual({ count: 1 });
  });

  it("has no steps for a user message", () => {
    const part: ChatMessage = { role: "user", content: "q", reasoning: "x" };
    expect(stepSummary([part])).toEqual({ count: 0 });
  });

  it("has no steps for an empty group", () => {
    expect(stepSummary([])).toEqual({ count: 0 });
  });
});

describe("stepSummary (a group of rounds)", () => {
  it("sums the counts of the rounds", () => {
    const first = assistant({
      reasoning: "a",
      toolCalls: [call("1"), call("2")],
    });
    const second = assistant({ toolCalls: [call("3")] });
    const third = assistant({ reasoning: "b" });
    expect(stepSummary([first, second])).toEqual({ count: 4 });
    expect(stepSummary([first, second, third]).count).toBe(5);
  });

  it("does not count note tools of any round", () => {
    const first = assistant({ toolCalls: [call("1")] });
    const second = assistant({ toolCalls: [call("2", "add_idea"), call("3")] });
    expect(stepSummary([first, second]).count).toBe(2);
  });
});
