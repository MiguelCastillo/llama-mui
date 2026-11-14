// What the usage log says about conversation size and compaction (see
// usageLog.ts and src/compact.ts): token use by how big the conversation was
// when a turn ended, and what the compactions cost and how well they worked. It
// is for judging the size at which a chat is compacted: use by size shows where
// the tokens go, and repeated calls after a compaction show whether compacting
// loses work. Tokens only, no cost. Pure, so it can be tested without files.

import { type UsageRecord, type UsageTotals, addTo, emptyTotals } from "./usageLog.ts";

// The conversation sizes (tokens) the report groups turns by. A turn belongs to
// the first band whose limit its size is under.
export const SIZE_BANDS: { label: string; under: number }[] = [
  { label: "Under 200k", under: 200_000 },
  { label: "200k to 400k", under: 400_000 },
  { label: "400k to 600k", under: 600_000 },
  { label: "600k and over", under: Infinity },
];

export const bandOf = (tokens: number): number => SIZE_BANDS.findIndex((b) => tokens < b.under);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export type SizeRow = { label: string; totals: UsageTotals };

// Turns grouped by the conversation's size at their last request. Turns from
// before the size was logged are left out (they have none).
export function bySize(records: UsageRecord[]): SizeRow[] {
  const rows: SizeRow[] = SIZE_BANDS.map((b) => ({ label: b.label, totals: emptyTotals() }));
  for (const r of records) {
    const size = num(r.contextTokens);
    if (size > 0) addTo(rows[bandOf(size)].totals, r);
  }
  return rows;
}

export type CompactionRow = {
  label: string;
  // Compactions that ran with the conversation this big.
  count: number;
  // Replies that followed them, up to the next compaction in the same chat.
  repliesAfter: number;
  // Tool calls in those replies that repeated one from before the history start.
  forgottenRereads: number;
  // Compactions followed by another one within five replies: a chat that fills
  // up again at once means compacting too early, or a summary plus the recent
  // part that is too big.
  soonAgain: number;
};

export type CompactionReport = {
  count: number;
  // Tokens the summary requests used, summed: what compacting itself costs.
  summaryTokens: Pick<UsageTotals, "input" | "output" | "cacheRead" | "cacheWrite">;
  // How much of the summary requests the server read from its cache instead of
  // processing again: cache read over cache read, cache written and fresh input,
  // summed over the compactions that have cache numbers. null with none. The
  // summary request is meant to start exactly like the request before it, so a
  // low share means that stopped being true.
  cacheReuse: number | null;
  // Compactions with cache numbers whose own share was under LOW_REUSE.
  lowReuse: number;
  byBand: CompactionRow[];
};

export const SOON_AGAIN = 5;
// A compaction that read less than this share of its request from the cache is
// flagged. A guess to tune: a healthy one reads nearly all of it.
export const LOW_REUSE = 0.5;

export function compactions(records: UsageRecord[]): CompactionReport {
  const rows: CompactionRow[] = SIZE_BANDS.map((b) => ({ label: b.label, count: 0, repliesAfter: 0, forgottenRereads: 0, soonAgain: 0 }));
  const summaryTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let count = 0;
  let reuseRead = 0;
  let reuseAll = 0;
  let lowReuse = 0;
  const bySession = new Map<string, UsageRecord[]>();
  for (const r of records) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  for (const turns of bySession.values()) {
    turns.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    let row: CompactionRow | null = null;
    let replies = 0;
    for (const r of turns) {
      if (r.compaction === true) {
        // The one before it ran out of room for the replies that followed.
        if (row && replies < SOON_AGAIN) row.soonAgain += 1;
        row = rows[bandOf(num(r.contextTokens))];
        row.count += 1;
        replies = 0;
        count += 1;
        summaryTokens.input += r.input;
        summaryTokens.output += r.output;
        summaryTokens.cacheRead += r.cacheRead;
        summaryTokens.cacheWrite += r.cacheWrite;
        // A turn with no cache numbers at all (a server that reports none) says
        // nothing about reuse, so it is left out.
        const all = r.input + r.cacheRead + r.cacheWrite;
        if (r.cacheRead + r.cacheWrite > 0 && all > 0) {
          reuseRead += r.cacheRead;
          reuseAll += all;
          if (r.cacheRead / all < LOW_REUSE) lowReuse += 1;
        }
      } else if (row) {
        row.repliesAfter += 1;
        row.forgottenRereads += num(r.forgottenRereads);
        replies += 1;
      }
    }
  }
  return { count, summaryTokens, cacheReuse: reuseAll > 0 ? reuseRead / reuseAll : null, lowReuse, byBand: rows };
}
