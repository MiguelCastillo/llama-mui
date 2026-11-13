// Where today's token total stands against the daily limit. A limit of 0 (or
// less) means no limit. Warns from 80%, stronger from 100%. Never blocks.
export const WARN_FRACTION = 0.8;

export type LimitLevel = "none" | "warn" | "over";

export function limitLevel(todayTotal: number, dailyLimit: number): LimitLevel {
  if (!(dailyLimit > 0)) return "none";
  if (todayTotal >= dailyLimit) return "over";
  if (todayTotal >= dailyLimit * WARN_FRACTION) return "warn";
  return "none";
}

export function limitMessage(todayTotal: number, dailyLimit: number): string | null {
  const level = limitLevel(todayTotal, dailyLimit);
  if (level === "none") return null;
  const used = `${todayTotal.toLocaleString()} of ${dailyLimit.toLocaleString()} tokens`;
  return level === "over"
    ? `Daily token limit passed: ${used} used today. Sending still works.`
    : `Close to the daily token limit: ${used} used today (${Math.round((todayTotal / dailyLimit) * 100)}%).`;
}
