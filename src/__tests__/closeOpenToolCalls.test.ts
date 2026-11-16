import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../api";
import { callsWaitingForAnswer, closeOpenToolCalls, MAY_HAVE_RUN_CALL, SAFE_TO_REPEAT_CALL, UNFINISHED_CALL } from "../closeOpenToolCalls";

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
  content: MAY_HAVE_RUN_CALL,
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

  it("has a short may-have-run text that does not mention a reload", () => {
    expect(MAY_HAVE_RUN_CALL).toMatch(/may not have finished/);
    expect(MAY_HAVE_RUN_CALL).toMatch(/Check the current state/);
    expect(MAY_HAVE_RUN_CALL).not.toMatch(/reload/);
  });

  it("gives a call waiting for approval the did-not-run text", () => {
    const out = closeOpenToolCalls([user("go"), assistant(["a"])], ["a"]);
    expect(out[2]).toEqual(synthetic("a", { content: UNFINISHED_CALL }));
  });

  it("gives a started call (not waiting) the may-have-run text", () => {
    const out = closeOpenToolCalls([user("go"), assistant(["a"])], []);
    expect(out[2]).toMatchObject({ toolCallId: "a", content: MAY_HAVE_RUN_CALL });
  });

  it("with two open calls and one waiting, gives one of each", () => {
    const out = closeOpenToolCalls([user("go"), assistant(["a", "b"])], ["b"]);
    expect(out[2]).toMatchObject({ toolCallId: "a", content: MAY_HAVE_RUN_CALL });
    expect(out[3]).toMatchObject({ toolCallId: "b", content: UNFINISHED_CALL });
  });

  it("finds the waiting call: the first open one in the last assistant message with any", () => {
    expect(callsWaitingForAnswer([user("go"), assistant(["a", "b"]), result("a")])).toEqual(["b"]);
    expect(callsWaitingForAnswer([user("go"), assistant(["a"]), result("a")])).toEqual([]);
  });

  describe("with the started mark", () => {
    const named = (id: string, name: string, started?: boolean): ToolCall => ({ id, name, arguments: "{}", ...(started ? { started } : {}) });
    const effect = (c: ToolCall) => (c.name === "read_file" ? "none" : "change") as "none" | "change";
    const withCalls = (...calls: ToolCall[]): ChatMessage[] => [user("go"), { role: "assistant", content: "", toolCalls: calls }];
    const texts = (out: ChatMessage[]) => out.filter((m) => m.role === "tool").map((m) => m.content);

    it("a started call may have run, whatever the tool", () => {
      expect(texts(closeOpenToolCalls(withCalls(named("a", "run_command", true)), [], effect))).toEqual([MAY_HAVE_RUN_CALL]);
      expect(texts(closeOpenToolCalls(withCalls(named("a", "read_file", true)), [], effect))).toEqual([MAY_HAVE_RUN_CALL]);
    });

    it("a changing call without the mark did not run, in a chat that has marks", () => {
      const out = closeOpenToolCalls(withCalls(named("a", "run_command", true), named("b", "write_file")), [], effect);
      expect(texts(out)).toEqual([MAY_HAVE_RUN_CALL, UNFINISHED_CALL]);
    });

    it("a read-only call is safe to repeat", () => {
      expect(texts(closeOpenToolCalls(withCalls(named("a", "read_file")), [], effect))).toEqual([SAFE_TO_REPEAT_CALL]);
    });

    it("an old chat without any mark keeps the earlier rule: waiting did not run, the rest may have", () => {
      const out = closeOpenToolCalls(withCalls(named("a", "run_command"), named("b", "run_command")), ["b"], effect);
      expect(texts(out)).toEqual([MAY_HAVE_RUN_CALL, UNFINISHED_CALL]);
      // Without knowing the tools (the page), the same.
      expect(texts(closeOpenToolCalls(withCalls(named("a", "read_file"), named("b", "run_command")), ["b"]))).toEqual([MAY_HAVE_RUN_CALL, UNFINISHED_CALL]);
    });

    it("an old chat's open read-only call is safe to repeat when the tools are known", () => {
      expect(texts(closeOpenToolCalls(withCalls(named("a", "read_file")), [], effect))).toEqual([SAFE_TO_REPEAT_CALL]);
    });
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
