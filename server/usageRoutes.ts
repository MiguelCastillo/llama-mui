// Routes for token usage (see usageLog.ts): totals by provider, by day and for
// one chat, today's total, and the daily limit that triggers a warning.

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { load, save } from "./store.ts";
import { dayOf, emptyTotals, readUsage, sumAll, sumByDay, sumByProvider, type UsageRecord, type UsageTotals } from "./usageLog.ts";

export const DAYS = 30;

export type UsageReport = {
  // Everything in the log, by provider.
  byProvider: Record<string, UsageTotals>;
  // The last DAYS local days, oldest first, a day with no turns included.
  byDay: { day: string; totals: UsageTotals }[];
  // The chat asked for with ?sessionId=, or undefined if none was.
  session?: UsageTotals;
  today: UsageTotals;
  // 0 means no limit is set.
  dailyTokenLimit: number;
};

// Pure, so it can be tested without files. `now` is when "today" is.
export function buildReport(records: UsageRecord[], dailyTokenLimit: number, sessionId: string | undefined, now = new Date()): UsageReport {
  const days: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    days.push(dayOf(d.toISOString()));
  }
  const perDay = sumByDay(records);
  const today = days[days.length - 1];
  return {
    byProvider: sumByProvider(records),
    byDay: days.map((day) => ({ day, totals: perDay[day] ?? emptyTotals() })),
    ...(sessionId ? { session: sumAll(records.filter((r) => r.sessionId === sessionId)) } : {}),
    today: perDay[today] ?? emptyTotals(),
    dailyTokenLimit,
  };
}

// A limit is a whole number of tokens, 0 or more; 0 turns it off.
export function parseLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
    throw new HttpError(400, "dailyTokenLimit must be a whole number of tokens, 0 or more (0 is off)");
  }
  return v;
}

// Handles /api/usage and /api/usage/limit; returns false for anything else.
export async function usageRoutes({ req, res, parts, method, search }: Route): Promise<boolean> {
  if (parts[0] !== "usage") return false;

  if (parts.length === 1 && method === "GET") {
    const sessionId = new URLSearchParams(search).get("sessionId") || undefined;
    const store = await load();
    sendJson(res, 200, buildReport(await readUsage(), store.dailyTokenLimit, sessionId));
    return true;
  }

  if (parts.length === 2 && parts[1] === "limit" && method === "PUT") {
    const body = await readJson(req);
    const limit = parseLimit(body.dailyTokenLimit);
    const store = await load();
    store.dailyTokenLimit = limit;
    await save(store);
    sendJson(res, 200, { dailyTokenLimit: limit });
    return true;
  }

  return false;
}
