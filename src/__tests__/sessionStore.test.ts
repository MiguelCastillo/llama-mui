import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../api";
import { emptySessionState } from "../sessionState";
import { createSessionStore } from "../sessionStore";

const msg = (content: string) => ({ role: "user", content }) as ChatMessage;

describe("session store", () => {
  it("starts empty and returns what was set", () => {
    const store = createSessionStore();
    expect(store.get()).toEqual(emptySessionState());
    const messages = [msg("hi")];
    store.update({ messages, persona: "Reviewer" });
    expect(store.get().messages).toBe(messages);
    expect(store.get().persona).toBe("Reviewer");
  });

  it("drops a change that alters nothing: same object, no listener", () => {
    const store = createSessionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.get();
    store.update({ messages: before.messages, persona: before.persona });
    store.update(() => ({}));
    expect(store.get()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    store.update({ persona: "Other" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).not.toBe(before);
  });

  it("gives a function update the latest state, even right after another", () => {
    const store = createSessionStore();
    store.update((s) => ({ messages: [...s.messages, msg("a")] }));
    store.update((s) => ({ messages: [...s.messages, msg("b")] }));
    store.update((s) => ({ messages: [...s.messages, msg("c")] }));
    expect(store.get().messages.map((m) => m.content)).toEqual(["a", "b", "c"]);
  });

  it("marks each change of the message list with its source and counts", () => {
    const store = createSessionStore();
    const marks: string[] = [];
    const stop = store.onMessages((m) => marks.push(m));
    store.update({ messages: [msg("a"), msg("b")] }, "server");
    store.update({ persona: "Reviewer" }, "server");
    store.update((s) => ({ messages: s.messages.slice(1) }));
    expect(marks).toEqual(["msgs:server:0>2", "msgs:page:2>1"]);
    stop();
    store.update({ messages: [] }, "server");
    expect(marks).toHaveLength(2);
  });

  it("stops calling a listener once unsubscribed", () => {
    const store = createSessionStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    stop();
    store.update({ persona: "Reviewer" });
    expect(listener).not.toHaveBeenCalled();
  });
});
