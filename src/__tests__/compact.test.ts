import { describe, expect, it } from "vitest";
import type { ChatMessage, Model, Usage } from "../api";
import { MAX_COMPACT_TRIES, mustCompactFirst, needsCompaction, summaryOf } from "../compact";
import { COMPACT_AT, CONTEXT_WARN_AT, contextShare } from "../contextShare";

const usage = (contextTokens: number): Usage => ({ contextTokens }) as Usage;
const models = [{ id: "m", contextSize: 1000 }, { id: "unknown" }] as Model[];
const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "user", content, ...extra });
const reply = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", content, ...extra });

describe("contextShare", () => {
  it("is the tokens in context over the window, or 0 when either is unknown", () => {
    expect(contextShare(usage(250), 1000)).toBe(0.25);
    expect(contextShare(null, 1000)).toBe(0);
    expect(contextShare(usage(250), undefined)).toBe(0);
  });
});

describe("needsCompaction", () => {
  it("starts at 60% of the window, before the meter turns orange at 80%", () => {
    expect(COMPACT_AT).toBe(0.6);
    expect(COMPACT_AT).toBeLessThan(CONTEXT_WARN_AT);
    expect(needsCompaction(usage(599), models, "m")).toBe(false);
    expect(needsCompaction(usage(600), models, "m")).toBe(true);
  });

  it("does not guess when the model's window or the usage is unknown", () => {
    expect(needsCompaction(usage(10_000), models, "unknown")).toBe(false);
    expect(needsCompaction(usage(10_000), models, "gone")).toBe(false);
    expect(needsCompaction(null, models, "m")).toBe(false);
    expect(needsCompaction(undefined, models, "m")).toBe(false);
  });
});

describe("mustCompactFirst", () => {
  it("is for a chat with no room left", () => {
    expect(mustCompactFirst(usage(999), models, "m")).toBe(false);
    expect(mustCompactFirst(usage(1000), models, "m")).toBe(true);
    expect(mustCompactFirst(usage(1200), models, "m")).toBe(true);
  });
});

describe("summaryOf", () => {
  it("finds the request and the reply that follows it", () => {
    const m = [user("a"), reply("b"), user("please summarize", { compaction: true }), reply("the summary", { compaction: true })];
    expect(summaryOf(m)).toEqual({ at: 2, summary: "the summary" });
  });

  it("uses the latest request when there were several", () => {
    const m = [
      user("x", { compaction: true }),
      reply("old", { compaction: true }),
      user("more"),
      user("y", { compaction: true }),
      reply("new", { compaction: true }),
    ];
    expect(summaryOf(m)).toEqual({ at: 3, summary: "new" });
  });

  it("is null when there is no request, or the reply has no text", () => {
    expect(summaryOf([user("a"), reply("b")])).toBeNull();
    expect(summaryOf([user("x", { compaction: true }), reply("  ", { compaction: true })])).toBeNull();
    expect(summaryOf([user("x", { compaction: true })])).toBeNull();
  });

  it("ignores a reply that is only tool calls and the model's other replies", () => {
    const calls = reply("", { compaction: true, toolCalls: [{ id: "c", name: "read_file", arguments: "{}" }] });
    expect(summaryOf([user("x", { compaction: true }), calls])).toBeNull();
    expect(summaryOf([user("x", { compaction: true }), reply("plain")])).toBeNull();
  });
});

describe("retries", () => {
  it("are limited", () => {
    expect(MAX_COMPACT_TRIES).toBe(2);
  });
});
