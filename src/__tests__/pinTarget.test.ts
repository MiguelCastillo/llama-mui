import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../api";
import { findPinned, pinKeyFor } from "../pinTarget";

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "user", content, ...extra });
const reply = (content: string): ChatMessage => ({ role: "assistant", content });

const before: ChatMessage[] = [user("hi"), reply("hello"), user("ok"), reply("sure")];

describe("findPinned", () => {
  it("isn't found before the message is drawn, so the chat tries again", () => {
    const key = pinKeyFor(before, "ok");
    // An earlier message with the same text is not the pinned one.
    expect(findPinned(before, key)).toBeNull();
  });

  it("finds the page's own copy of the sent message", () => {
    const key = pinKeyFor(before, "ok");
    expect(findPinned([...before, user("ok")], key)).toBe(4);
  });

  it("still finds it after the list is replaced with an equal server copy", () => {
    const key = pinKeyFor(before, "next");
    const shown = [...before, user("next")];
    // Same messages, new objects, as the session's answer from the server.
    const server = shown.map((m) => ({ ...m }));
    expect(findPinned(server, key)).toBe(findPinned(shown, key));
    expect(server[findPinned(server, key)!].content).toBe("next");
  });

  it("follows the message when the server's copy shifts its index", () => {
    const key = pinKeyFor(before, "next");
    // The server's copy has a system message first and a tool result the page
    // hadn't drawn: the index moved, the message didn't.
    const server: ChatMessage[] = [
      { role: "system", content: "persona" },
      ...before,
      { role: "tool", content: "result", toolCallId: "c1" },
      user("next"),
    ];
    expect(findPinned(server, key)).toBe(6);
  });

  it("doesn't count side questions, plan steps or compaction requests", () => {
    const withOthers = [...before, user("aside", { aside: true }), user("step", { planStep: "s1" }), user("compact", { compaction: true })];
    const key = pinKeyFor(withOthers, "next");
    expect(findPinned([...withOthers, user("next")], key)).toBe(7);
  });

  it("finds it by text when another message of the user's came first", () => {
    const key = pinKeyFor(before, "next");
    // A message queued earlier landed before it in the server's copy.
    expect(findPinned([...before, user("queued"), reply("done"), user("next")], key)).toBe(6);
  });

  it("finds an edited message at its place, whatever text it had", () => {
    const key = pinKeyFor(before.slice(0, 2), "ok, but shorter");
    expect(findPinned(before, key)).toBe(2);
  });
});
