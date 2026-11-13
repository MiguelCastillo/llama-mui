import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Point the home folder at a temp one: these tests never touch the real log or settings.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { load } = await import("../store.ts");
const { appendUsage } = await import("../usageLog.ts");
const { buildReport, parseLimit, usageRoutes } = await import("../usageRoutes.ts");

const invoke = async (method: string, parts: string[], search = "", body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    headers: {},
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await usageRoutes({ req, res, parts, method, search } as any);
  return { status: res.statusCode, body: text ? JSON.parse(text) : {} };
};

const rec = (timestamp: string, sessionId: string, provider: string, input: number, output: number) => ({
  timestamp,
  sessionId,
  provider,
  model: "m",
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});

describe("buildReport", () => {
  const now = new Date(2025, 5, 15, 10, 0, 0);
  const at = (d: number, h = 9) => new Date(2025, 5, d, h).toISOString();
  const records = [rec(at(15), "a", "P1", 10, 5), rec(at(15, 11), "b", "P2", 1, 1), rec(at(14), "a", "P1", 100, 50), rec(at(1, 8), "a", "P1", 7, 0)];

  it("groups by provider, over everything", () => {
    const r = buildReport(records, 0, undefined, now);
    expect(r.byProvider.P1.total).toBe(172);
    expect(r.byProvider.P2.total).toBe(2);
  });

  it("lists the last 30 days, oldest first, with empty days included", () => {
    const r = buildReport(records, 0, undefined, now);
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay[29].day).toBe("2025-06-15");
    expect(r.byDay[0].day).toBe("2025-05-17");
    expect(r.byDay[28].totals.total).toBe(150);
    expect(r.byDay[27].totals.turns).toBe(0);
  });

  it("leaves out turns older than 30 days from the day list but not from providers", () => {
    const r = buildReport([rec(new Date(2025, 3, 1).toISOString(), "a", "P1", 9, 9)], 0, undefined, now);
    expect(r.byDay.every((d) => d.totals.turns === 0)).toBe(true);
    expect(r.byProvider.P1.total).toBe(18);
  });

  it("gives today's total, the chat's total and the limit", () => {
    const r = buildReport(records, 1000, "a", now);
    expect(r.today.total).toBe(17);
    expect(r.session?.total).toBe(172);
    expect(r.dailyTokenLimit).toBe(1000);
    expect(buildReport(records, 0, undefined, now).session).toBeUndefined();
  });
});

describe("parseLimit", () => {
  it("accepts 0 and whole numbers", () => {
    expect(parseLimit(0)).toBe(0);
    expect(parseLimit(50000)).toBe(50000);
  });
  it("refuses anything else", () => {
    for (const v of [-1, 1.5, "10", null, NaN]) expect(() => parseLimit(v)).toThrow(/whole number/);
  });
});

describe("the usage routes", () => {
  it("has no daily limit by default", async () => {
    expect((await load()).dailyTokenLimit).toBe(0);
    expect((await invoke("GET", ["usage"])).body.dailyTokenLimit).toBe(0);
  });

  it("reports what was logged, for one chat too", async () => {
    await appendUsage({ sessionId: "s1", provider: "Local", model: "m", input: 20, output: 5, cacheRead: 0, cacheWrite: 0 });
    await appendUsage({ sessionId: "s2", provider: "Cloud", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
    const r = (await invoke("GET", ["usage"], "?sessionId=s1")).body;
    expect(r.byProvider.Local.total).toBe(25);
    expect(r.session.total).toBe(25);
    expect(r.today.total).toBe(27);
  });

  it("saves the limit and reports it", async () => {
    expect((await invoke("PUT", ["usage", "limit"], "", { dailyTokenLimit: 100000 })).body.dailyTokenLimit).toBe(100000);
    expect((await load()).dailyTokenLimit).toBe(100000);
    expect((await invoke("GET", ["usage"])).body.dailyTokenLimit).toBe(100000);
    await invoke("PUT", ["usage", "limit"], "", { dailyTokenLimit: 0 });
    expect((await load()).dailyTokenLimit).toBe(0);
  });

  it("refuses a bad limit and keeps the old one", async () => {
    await expect(invoke("PUT", ["usage", "limit"], "", { dailyTokenLimit: -5 })).rejects.toThrow(/whole number/);
    expect((await load()).dailyTokenLimit).toBe(0);
  });
});
