import { describe, expect, it } from "vitest";
import { KEEP_SENT_MS, keepOrTake, type SentMessage } from "../keepSent";

const before = [
  { role: "user", content: "a" },
  { role: "assistant", content: "b" },
];
const sent: SentMessage = { session: "s1", index: 2, content: "hello", at: 1000 };

describe("keeping a just-sent message on screen", () => {
  it("keeps the list when the server's copy is from before the send", () => {
    expect(keepOrTake(before, sent, "s1", 1100)).toBe("keep");
    expect(keepOrTake(before.slice(0, 1), sent, "s1", 1100)).toBe("keep");
  });

  it("takes a copy that holds the message, however its text is stored", () => {
    expect(keepOrTake([...before, { role: "user", content: "hello" }], sent, "s1", 1100)).toBe("take");
    expect(keepOrTake([...before, { role: "user", content: "hello " }], sent, "s1", 1100)).toBe("take");
    expect(keepOrTake([...before, { role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", content: "" }], sent, "s1", 1100)).toBe("take");
  });

  it("takes everything when nothing waits, in another chat, or after the wait", () => {
    expect(keepOrTake(before, null, "s1", 1100)).toBe("take");
    expect(keepOrTake(before, sent, "s2", 1100)).toBe("take");
    expect(keepOrTake(before, sent, "s1", 1000 + KEEP_SENT_MS + 1)).toBe("take");
  });
});
