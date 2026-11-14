import { describe, expect, it } from "vitest";
import { buildReport } from "../usageRoutes.ts";
import { LOW_REUSE, SIZE_BANDS, SOON_AGAIN, bandOf, bySize, compactions } from "../usageSizes.ts";
import type { UsageRecord } from "../usageLog.ts";

let clock = 0;
const turn = (sessionId: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  timestamp: new Date(Date.UTC(2026, 10, 14, 12, 0, clock++)).toISOString(),
  sessionId,
  provider: "Anthropic",
  model: "m",
  input: 10,
  output: 5,
  cacheRead: 100,
  cacheWrite: 1,
  ...extra,
});
const compaction = (sessionId: string, contextTokens: number, extra: Partial<UsageRecord> = {}) =>
  turn(sessionId, { compaction: true, contextTokens, input: 7, output: 300, cacheRead: contextTokens, cacheWrite: 0, ...extra });

describe("bandOf", () => {
  it("puts a size in the first band it is under, the edges in the band above", () => {
    expect(SIZE_BANDS.map((b) => b.label)).toEqual(["Under 200k", "200k to 400k", "400k to 600k", "600k and over"]);
    expect(bandOf(1)).toBe(0);
    expect(bandOf(199_999)).toBe(0);
    expect(bandOf(200_000)).toBe(1);
    expect(bandOf(599_999)).toBe(2);
    expect(bandOf(600_000)).toBe(3);
    expect(bandOf(5_000_000)).toBe(3);
  });
});

describe("bySize", () => {
  it("sums each band's turns by the size at their last request", () => {
    const rows = bySize([
      turn("a", { contextTokens: 50_000 }),
      turn("a", { contextTokens: 150_000, input: 20 }),
      turn("b", { contextTokens: 450_000 }),
      turn("b", { contextTokens: 700_000 }),
    ]);
    expect(rows.map((r) => r.totals.turns)).toEqual([2, 0, 1, 1]);
    expect(rows[0].totals).toMatchObject({ input: 30, output: 10, cacheRead: 200, cacheWrite: 2, total: 40 });
  });

  it("leaves out turns that have no size, such as ones logged before it was", () => {
    const rows = bySize([turn("a"), turn("a", { contextTokens: 0 }), turn("a", { contextTokens: "big" as unknown as number })]);
    expect(rows.every((r) => r.totals.turns === 0)).toBe(true);
  });
});

describe("compactions", () => {
  it("is empty with no compaction", () => {
    const c = compactions([turn("a", { contextTokens: 100_000 })]);
    expect(c.count).toBe(0);
    expect(c.summaryTokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(c.byBand.every((b) => b.count === 0)).toBe(true);
  });

  it("counts them by the chat's size when compacted, and sums what the summary requests used", () => {
    const c = compactions([compaction("a", 650_000), compaction("b", 650_000), compaction("c", 150_000)]);
    expect(c.count).toBe(3);
    expect(c.byBand.map((b) => b.count)).toEqual([1, 0, 0, 2]);
    expect(c.summaryTokens).toEqual({ input: 21, output: 900, cacheRead: 1_450_000, cacheWrite: 0 });
  });

  it("counts the replies after a compaction and the repeated calls in them, up to the next compaction", () => {
    const c = compactions([
      turn("a", { contextTokens: 600_000 }),
      compaction("a", 620_000),
      turn("a", { forgottenRereads: 2 }),
      turn("a", { forgottenRereads: 1 }),
      turn("a"),
    ]);
    const row = c.byBand[3];
    expect(row).toMatchObject({ count: 1, repliesAfter: 3, forgottenRereads: 3, soonAgain: 0 });
  });

  it("gives the replies and repeats after a compaction to that compaction's size band", () => {
    const c = compactions([
      compaction("a", 650_000),
      turn("a", { forgottenRereads: 1 }),
      compaction("a", 250_000),
      turn("a", { forgottenRereads: 4 }),
    ]);
    expect(c.byBand[3]).toMatchObject({ repliesAfter: 1, forgottenRereads: 1 });
    expect(c.byBand[1]).toMatchObject({ repliesAfter: 1, forgottenRereads: 4 });
  });

  it("notes a chat that was compacted again within a few replies, and not one that waited", () => {
    const quick = [compaction("a", 650_000), ...Array.from({ length: SOON_AGAIN - 1 }, () => turn("a")), compaction("a", 650_000)];
    expect(compactions(quick).byBand[3].soonAgain).toBe(1);
    const slow = [compaction("b", 650_000), ...Array.from({ length: SOON_AGAIN }, () => turn("b")), compaction("b", 650_000)];
    expect(compactions(slow).byBand[3].soonAgain).toBe(0);
  });

  it("keeps each chat's turns apart, in the order they happened", () => {
    const c = compactions([
      compaction("a", 650_000),
      turn("b", { forgottenRereads: 9 }),
      turn("a", { forgottenRereads: 1 }),
    ]);
    // b's turn has no compaction before it.
    expect(c.byBand[3]).toMatchObject({ repliesAfter: 1, forgottenRereads: 1 });
    const unordered = [turn("a", { forgottenRereads: 5 }), compaction("a", 650_000, { timestamp: "2026-11-14T11:00:00.000Z" })];
    expect(compactions(unordered).byBand[3]).toMatchObject({ repliesAfter: 1, forgottenRereads: 5 });
  });
});

describe("cache reuse of the summary requests", () => {
  // A summary request that reads the chat from the cache and writes only itself.
  const healthy = (id: string) => compaction(id, 650_000, { input: 4, cacheRead: 650_000, cacheWrite: 200 });
  // One that processed the whole chat again.
  const cold = (id: string) => compaction(id, 650_000, { input: 4, cacheRead: 0, cacheWrite: 650_000 });

  it("is the share read from the cache, summed over the compactions", () => {
    const c = compactions([healthy("a"), healthy("b")]);
    expect(c.cacheReuse).toBeCloseTo(650_000 / 650_204, 6);
    expect(c.lowReuse).toBe(0);
  });

  it("flags a compaction that read less than half from the cache", () => {
    expect(LOW_REUSE).toBe(0.5);
    const c = compactions([healthy("a"), cold("b")]);
    expect(c.lowReuse).toBe(1);
    expect(c.cacheReuse).toBeLessThan(0.55);
    expect(compactions([cold("a")]).cacheReuse).toBe(0);
  });

  it("is exactly at the line when half was read, and not flagged", () => {
    const c = compactions([compaction("a", 100, { input: 0, cacheRead: 50, cacheWrite: 50 })]);
    expect(c.cacheReuse).toBe(0.5);
    expect(c.lowReuse).toBe(0);
  });

  it("says nothing for a compaction that has no cache numbers", () => {
    const none = compaction("a", 650_000, { input: 650_000, cacheRead: 0, cacheWrite: 0 });
    const c = compactions([none]);
    expect(c.cacheReuse).toBeNull();
    expect(c.lowReuse).toBe(0);
    expect(c.count).toBe(1);
    expect(compactions([]).cacheReuse).toBeNull();
  });

  it("ignores turns that are not compactions", () => {
    const c = compactions([turn("a", { contextTokens: 100_000, cacheRead: 0, cacheWrite: 9_999_999 }), healthy("a")]);
    expect(c.lowReuse).toBe(0);
    expect(c.cacheReuse).toBeGreaterThan(0.99);
  });
});

describe("buildReport", () => {
  it("carries the size table and the compactions", () => {
    const report = buildReport([turn("a", { contextTokens: 50_000 }), compaction("a", 650_000)], 0, undefined, new Date(Date.UTC(2026, 10, 14, 12)));
    expect(report.bySize[0].totals.turns).toBe(1);
    expect(report.bySize[3].totals.turns).toBe(1);
    expect(report.compactions.count).toBe(1);
  });
});
