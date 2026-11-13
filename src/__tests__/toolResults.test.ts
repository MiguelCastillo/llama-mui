import { describe, expect, it } from "vitest";
import {
  IDLE_MS,
  clearOldToolResults,
  clearedBy,
  crossReplyCount,
  cutWithinReply,
  heavyCount,
  requestCount,
  rereads,
  toolResultStub,
  turnCount,
} from "../toolResults.ts";

type M = { role: string; content: string; toolCalls?: { id: string; name: string; arguments: string }[]; toolCallId?: string };

// A chat: one entry per reply, the number of tool calls it made. Each result
// is `size` characters. The last reply is still going when `open` is set (no
// closing text yet).
function chat(replies: number[], { size = 20_000, open = false } = {}): M[] {
  const out: M[] = [];
  let id = 0;
  replies.forEach((calls, r) => {
    out.push({ role: "user", content: `message ${r}` });
    for (let i = 0; i < calls; i++, id++) {
      out.push({ role: "assistant", content: "", toolCalls: [{ id: `c${id}`, name: "read_file", arguments: `{"path":"f${id}"}` }] });
      out.push({ role: "tool", content: `${id}:`.padEnd(size, "x"), toolCallId: `c${id}` });
    }
    if (!(open && r === replies.length - 1)) out.push({ role: "assistant", content: `reply ${r}` });
  });
  return out;
}
const results = (ms: M[]) => ms.filter((m) => m.role === "tool").map((m) => m.content);
const stubs = (ms: M[]) => results(ms).filter((r) => r.startsWith("[Removed")).length;
const sent = (ms: M[], turn?: number) => clearOldToolResults(ms, requestCount(ms, turn));
// Light results (about 1.5k tokens each), so no reply is heavy on its own.
const LIGHT = { size: 6_000 };

describe("what the cut would leave out now", () => {
  it("nothing while the chat is short", () => {
    expect(crossReplyCount(chat([3, 3, 3], { size: 100 }))).toBe(0);
  });

  it("past the threshold, the results of the replies before the last one", () => {
    expect(crossReplyCount(chat([3, 3, 2, 1], { open: true }))).toBe(6);
    const out = results(sent(chat([3, 3, 2, 1], { open: true })));
    expect(out.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => toolResultStub("read_file", 20_000)));
    expect(out.slice(6).every((r) => r.length === 20_000)).toBe(true);
    expect(out[0]).toMatch(/Call the tool again if you need it/);
  });

  it("never changes the messages it was given (the saved chat)", () => {
    const ms = chat([3, 3, 3]);
    const before = JSON.stringify(ms);
    sent(ms);
    expect(JSON.stringify(ms)).toBe(before);
  });

  it("keeps short results whole: a stub in their place would save nothing", () => {
    const ms = chat([3, 3, 3]);
    ms[2] = { ...ms[2], content: "short output ".repeat(50) };
    expect(results(clearOldToolResults(ms, 3))[0]).toBe("short output ".repeat(50));
  });
});

describe("when the cut moves: once per turn, from what the chat saved", () => {
  const now = 1_000_000_000;
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  const ms = chat([10, 10, 3, 0], { ...LIGHT, open: true });

  it("the first time a chat is long, it starts where the rule says", () => {
    expect(turnCount(ms, undefined, 0, now)).toBe(20);
  });

  it("stays where it was while the cache is warm (answered within five minutes)", () => {
    expect(turnCount(ms, { from: 0, count: 10, lastRequestAt: at(2) }, 0, now)).toBe(10);
  });

  it("moves once the cache has gone (idle five minutes or more)", () => {
    expect(turnCount(ms, { from: 0, count: 10, lastRequestAt: now - IDLE_MS }, 0, now)).toBe(20);
  });

  it("moves while warm too when enough has piled up behind it", () => {
    const heavy = chat([10, 10, 10, 3, 0], { size: 20_000, open: true });
    // 20 results of about 5k tokens each wait behind a cut at 10: past 50k.
    expect(turnCount(heavy, { from: 0, count: 10, lastRequestAt: at(1) }, 0, now)).toBe(30);
  });

  it("never moves back, and a Clear context starts afresh", () => {
    expect(turnCount(chat([10, 3, 0], { ...LIGHT, open: true }), { from: 0, count: 10, lastRequestAt: at(10) }, 0, now)).toBe(10);
    expect(turnCount(ms, { from: 5, count: 3, lastRequestAt: at(1) }, 0, now)).toBe(20);
  });

  it("within a turn, each request starts exactly as the one before it did", () => {
    for (let calls = 1; calls < 6; calls++) {
      const before = sent(chat([10, 10, calls], { ...LIGHT, open: true }), 10);
      const after = sent(chat([10, 10, calls + 1], { ...LIGHT, open: true }), 10);
      expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    }
  });
});

describe("one heavy turn", () => {
  it("is cut by weight: past 30k tokens kept, down to under 10k", () => {
    // 20k characters is about 5k tokens: the seventh result passes 30k.
    expect(cutWithinReply(Array(6).fill(20_000))).toBe(0);
    expect(cutWithinReply(Array(7).fill(20_000))).toBe(5);
    expect(cutWithinReply(Array(200).fill(400))).toBe(0);
    expect(cutWithinReply([20_000, 20_000, 400_000])).toBe(2);
  });

  it("leaves out everything before the turn too, and goes further than the turn's count", () => {
    const ms = chat([2, 7], { open: true });
    expect(heavyCount(ms)).toBe(2 + 5);
    expect(requestCount(ms, 0)).toBe(7);
  });

  it("moves rarely: each request starts as the last one did, but at a handful of moves", () => {
    let moves = 0;
    for (let calls = 1; calls < 30; calls++) {
      const a = requestCount(chat([calls], { open: true }), 0);
      const b = requestCount(chat([calls + 1], { open: true }), 0);
      if (a !== b) moves++;
      else {
        const before = clearOldToolResults(chat([calls], { open: true }), a);
        const after = clearOldToolResults(chat([calls + 1], { open: true }), b);
        expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
      }
    }
    expect(moves).toBeLessThanOrEqual(7);
  });
});

describe("counting what was left out, for the usage log", () => {
  it("counts the results and roughly the tokens left out, net of their stubs", () => {
    const c = clearedBy(chat([3, 3, 2]), 3, { skipSmall: true });
    expect(c.results).toBe(3);
    // 20k characters is 5,000 tokens; a stub is a few dozen.
    expect(c.tokens).toBeGreaterThan(3 * 4_900);
    expect(c.tokens).toBeLessThan(3 * 5_000);
    expect(c.calls[0]).toEqual({ name: "read_file", arguments: '{"path":"f0"}' });
  });

  it("on llama.cpp, a short result kept whole isn't counted; Anthropic clears it, so it is there", () => {
    const ms = chat([3, 3, 2]);
    ms[2] = { ...ms[2], content: "short" };
    expect(clearedBy(ms, 3, { skipSmall: true }).results).toBe(2);
    expect(clearedBy(ms, 3, { skipSmall: false }).results).toBe(3);
  });

  it("a re-read is the same tool with the same arguments as one left out, whatever the spacing", () => {
    const c = clearedBy(chat([3, 3, 2]), 3, { skipSmall: true });
    expect(
      rereads(c, [
        { name: "read_file", arguments: '{ "path": "f1" }' },
        { name: "read_file", arguments: '{"path":"f9"}' },
        { name: "grep", arguments: '{"path":"f1"}' },
      ]),
    ).toBe(1);
  });
});
