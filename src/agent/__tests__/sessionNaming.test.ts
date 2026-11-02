import { describe, it, expect, vi, beforeEach } from "vitest";
import { namingPrompt, parseNamingAnswer, askForSessionName } from "../sessionNaming";
import { type ChatMessage } from "../../api";

// vi.hoisted runs in the hoisted scope (same scope as vi.mock), so the
// variable is available when the mock factory is evaluated.
const { mockStreamChat } = vi.hoisted(() => ({
  mockStreamChat: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, streamChat: mockStreamChat };
});

import { streamChat } from "../../api";

// ── namingPrompt ────────────────────────────────────────────────────────────

describe("namingPrompt", () => {
  it("includes the last 10 messages", () => {
    const messages: ChatMessage[] = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}`,
    }));
    const prompt = namingPrompt(messages);
    // Should include messages 5-14 (last 10)
    expect(prompt).toContain("Message 5");
    expect(prompt).toContain("Message 14");
    // Should not include messages before 5
    expect(prompt).not.toContain("Message 0");
  });

  it("handles fewer than 10 messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const prompt = namingPrompt(messages);
    expect(prompt).toContain("Hello");
    expect(prompt).toContain("Hi there");
  });
});

// ── parseNamingAnswer ───────────────────────────────────────────────────────

describe("parseNamingAnswer", () => {
  it("returns the trimmed line for a clean answer", () => {
    expect(parseNamingAnswer("Llama chat about code")).toBe("Llama chat about code");
  });

  it("returns null for too few words", () => {
    expect(parseNamingAnswer("Hi there")).toBeNull();
  });

  it("returns null for too many words", () => {
    expect(parseNamingAnswer("One two three four five six seven")).toBeNull();
  });

  it("strips surrounding quotes", () => {
    expect(parseNamingAnswer('"Llama chat about code"')).toBe("Llama chat about code");
    expect(parseNamingAnswer("'Llama chat about code'")).toBe("Llama chat about code");
  });

  it("handles multi-line answers (takes first line)", () => {
    const answer = `Sure, here is a name:
Llama chat about code
Hope that helps!`;
    expect(parseNamingAnswer(answer)).toBe("Llama chat about code");
  });

  it("returns null for blank answer", () => {
    expect(parseNamingAnswer("")).toBeNull();
    expect(parseNamingAnswer("\n\n")).toBeNull();
  });

  it("handles 3 words exactly", () => {
    expect(parseNamingAnswer("three words here")).toBe("three words here");
  });

  it("handles 6 words exactly", () => {
    expect(parseNamingAnswer("one two three four five six")).toBe("one two three four five six");
  });

  it("strips leading dash", () => {
    expect(parseNamingAnswer("- Llama chat about code")).toBe("Llama chat about code");
  });
});

// ── askForSessionName ───────────────────────────────────────────────────────

describe("askForSessionName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the parsed name when streamChat succeeds", async () => {
    mockStreamChat.mockImplementation(async (_params: any, callback: (d: { content?: string }) => void) => {
      callback({ content: "Llama chat about code" });
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const name = await askForSessionName(messages, "test-connector", "test-model", new AbortController().signal);
    expect(name).toBe("Llama chat about code");
    expect(mockStreamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: "test-connector",
        model: "test-model",
        think: false,
        tools: [],
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it("returns null when streamChat throws", async () => {
    mockStreamChat.mockRejectedValue(new Error("Network error"));

    const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
    const name = await askForSessionName(messages, "test-connector", "test-model", new AbortController().signal);
    expect(name).toBeNull();
  });

  it("returns null when the parsed answer is not useful", async () => {
    mockStreamChat.mockImplementation(async (_params: any, callback: (d: { content?: string }) => void) => {
      callback({ content: "OK" });
    });

    const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
    const name = await askForSessionName(messages, "test-connector", "test-model", new AbortController().signal);
    expect(name).toBeNull();
  });

  it("collects multiple streamed pieces", async () => {
    mockStreamChat.mockImplementation(async (_params: any, callback: (d: { content?: string }) => void) => {
      callback({ content: "Llama" });
      callback({ content: " chat" });
      callback({ content: " about" });
      callback({ content: " code" });
    });

    const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
    const name = await askForSessionName(messages, "test-connector", "test-model", new AbortController().signal);
    expect(name).toBe("Llama chat about code");
  });
});
