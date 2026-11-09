import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../api";
import { lastEditable } from "../editLast";

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "user", content, ...extra });
const bot = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", content, ...extra });

describe("lastEditable", () => {
  it("returns the last user message with its position", () => {
    const messages = [user("one"), bot("a"), user("two"), bot("b")];
    expect(lastEditable(messages, false, false)).toEqual({ index: 2, text: "two", images: [] });
  });

  it("returns the images the message was sent with", () => {
    const images = [{ id: "img-1", mediaType: "image/png" }];
    const messages = [user("look", { images }), bot("ok")];
    expect(lastEditable(messages, false, false)?.images).toEqual(images);
  });

  it("skips side questions and their replies", () => {
    const messages = [
      user("main"),
      bot("answer"),
      user("side", { aside: true }),
      bot("side answer", { aside: true }),
    ];
    expect(lastEditable(messages, false, false)).toEqual({ index: 0, text: "main", images: [] });
  });

  it("skips messages that belong to a plan step", () => {
    const messages = [user("main"), bot("answer"), user("step prompt", { planStep: "s1" })];
    expect(lastEditable(messages, false, false)?.index).toBe(0);
  });

  it("is null while a plan runs", () => {
    expect(lastEditable([user("hi"), bot("hello")], true, false)).toBeNull();
  });

  it("is null while a reply streams", () => {
    expect(lastEditable([user("hi")], false, true)).toBeNull();
  });

  it("is null when there is no user message", () => {
    expect(lastEditable([], false, false)).toBeNull();
    expect(lastEditable([bot("hello")], false, false)).toBeNull();
    expect(lastEditable([user("side", { aside: true })], false, false)).toBeNull();
  });
});
