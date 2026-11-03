import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../api";
import { closeOpenToolCalls, UNFINISHED_CALL } from "../closeOpenToolCalls";

const call = (id: string): ToolCall => ({ id, name: "read_file", arguments: "{}" });
const assistant = (ids: string[], extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: "assistant",
  content: "",
  toolCalls: ids.map(call),
  ...extra,
});
const result = (id: string, content = "ok"): ChatMessage => ({ role: "tool", content, toolCallId: id });
const user = (content: string): ChatMessage => ({ role: "user", content });
const synthetic = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: "tool",
  content: UNFINISHED_CALL,
  toolCallId: id,
  stats: { ms: 0, tokens: 0 },
  ...extra,
});

describe("closeOpenToolCalls", () => {
  it("uses the wording from the spec", () => {
    expect(UNFINISHED_CALL).toBe(
      "This call did not run: it was cut off before it finished (the page was reloaded while it waited).",
    );
  });

  it("leaves a chat without tool calls alone", () => {
    const messages = [user("hi"), { role: "assistant", content: "hello" } as ChatMessage];
    expect(closeOpenToolCalls(messages)).toEqual(messages);
    expect(closeOpenToolCalls([])).toEqual([]);
  });

  it("leaves answered calls alone", () => {
    const messages = [user("go"), assistant(["a", "b"]), result("a"), result("b"), user("next")];
    expect(closeOpenToolCalls(messages)).toEqual(messages);
  });

  it("closes one orphan at the end", () => {
    const messages = [user("go"), assistant(["a"])];
    expect(closeOpenToolCalls(messages)).toEqual([...messages, synthetic("a")]);
  });

  it("closes an orphan that a later user message follows", () => {
    const out = closeOpenToolCalls([user("go"), assistant(["a"]), user("hello?")]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(out[2]).toEqual(synthetic("a"));
  });

  it("closes the two missing calls of an assistant with three, after the answered one", () => {
    const out = closeOpenToolCalls([user("go"), assistant(["a", "b", "c"]), result("b", "found it"), user("next")]);
    expect(out).toEqual([
      user("go"),
      assistant(["a", "b", "c"]),
      result("b", "found it"),
      synthetic("a"),
      synthetic("c"),
      user("next"),
    ]);
  });

  it("closes the orphans of several assistant messages, each right after its own", () => {
    const out = closeOpenToolCalls([
      user("go"),
      assistant(["a"]),
      result("a"),
      assistant(["b"]),
      user("again"),
      assistant(["c", "d"]),
    ]);
    expect(out.map((m) => (m.role === "tool" ? `tool:${m.toolCallId}` : m.role))).toEqual([
      "user",
      "assistant",
      "tool:a",
      "assistant",
      "tool:b",
      "user",
      "assistant",
      "tool:c",
      "tool:d",
    ]);
    expect(out[4]).toEqual(synthetic("b"));
  });

  it("carries the assistant's planStep to the added result", () => {
    const out = closeOpenToolCalls([assistant(["a"], { planStep: "s2" })]);
    expect(out[1]).toEqual(synthetic("a", { planStep: "s2" }));
  });

  it("adds no planStep when the assistant has none", () => {
    const out = closeOpenToolCalls([assistant(["a"])]);
    expect(out[1]).not.toHaveProperty("planStep");
  });

  it("does not change its input", () => {
    const messages = [user("go"), assistant(["a"])];
    const copy = structuredClone(messages);
    closeOpenToolCalls(messages);
    expect(messages).toEqual(copy);
  });

  it("is idempotent", () => {
    const once = closeOpenToolCalls([
      user("go"),
      assistant(["a", "b", "c"], { planStep: "s1" }),
      result("b"),
      assistant(["d"]),
    ]);
    const twice = closeOpenToolCalls(once);
    expect(twice).toEqual(once);
    expect(twice).toBe(once);
  });
});
