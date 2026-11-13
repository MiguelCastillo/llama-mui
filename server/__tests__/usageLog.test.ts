import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

// Point the home folder at a temp one: these tests must never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { appendUsage, readUsage, usageFile, sumAll, sumByDay, sumByProvider, sumBySession, toRecord } = await import("../usageLog.ts");

const rec = (over: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  provider: "local",
  model: "m",
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  ...over,
});

describe("usage log", () => {
  it("reads an empty list when there is no file", async () => {
    expect(await readUsage()).toEqual([]);
  });

  it("appends one line per record and reads them back in order", async () => {
    await appendUsage(rec({ timestamp: "2025-01-01T10:00:00.000Z" }));
    await appendUsage(rec({ sessionId: "s2", provider: "claude", input: 100, output: 20, cacheRead: 7 }));
    const text = await readFile(usageFile(), "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    const all = await readUsage();
    expect(all.map((r) => r.sessionId)).toEqual(["s1", "s2"]);
    expect(all[0].timestamp).toBe("2025-01-01T10:00:00.000Z");
    expect(all[1].cacheRead).toBe(7);
    expect(Number.isNaN(Date.parse(all[1].timestamp))).toBe(false);
  });

  it("keeps unknown fields and skips damaged lines", async () => {
    await appendUsage(rec({ cost: 0.5 }));
    await writeFile(usageFile(), `${await readFile(usageFile(), "utf8")}{"half\nnot json\n[]\n`);
    const all = await readUsage();
    expect(all.at(-1)?.cost).toBe(0.5);
    expect(all.every((r) => typeof r.provider === "string")).toBe(true);
  });

  it("refuses a record with no provider", async () => {
    await expect(appendUsage(rec({ provider: undefined }))).rejects.toThrow();
  });

  it("treats missing or bad counts as 0", () => {
    const r = toRecord({ timestamp: "2025-01-01T00:00:00Z", sessionId: "a", provider: "p", input: "x", output: -3 });
    expect(r).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: "" });
  });

  it("sums by session, provider and day", () => {
    const records = [
      toRecord(rec({ timestamp: "2025-03-10T12:00:00" }))!,
      toRecord(rec({ timestamp: "2025-03-10T13:00:00", provider: "claude", input: 1, output: 2, cacheWrite: 4 }))!,
      toRecord(rec({ timestamp: "2025-03-11T12:00:00", sessionId: "s2" }))!,
    ];
    expect(sumAll(records)).toMatchObject({ input: 21, output: 12, cacheWrite: 4, total: 33, turns: 3 });
    expect(sumBySession(records).s1.total).toBe(18);
    expect(sumBySession(records).s2.turns).toBe(1);
    expect(sumByProvider(records).local.total).toBe(30);
    expect(sumByProvider(records).claude.total).toBe(3);
    expect(Object.keys(sumByDay(records))).toEqual(["2025-03-10", "2025-03-11"]);
    expect(sumByDay(records)["2025-03-10"].total).toBe(18);
  });
});
