// The token usage log: one JSON object per line in ~/.llama-mui/usage.jsonl,
// one line for each finished turn. It is append-only. Nothing here prices a
// turn or blocks one; a later layer can add a cost field to a record (unknown
// fields are kept as they are) or check the totals before a turn starts.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type UsageRecord = {
  // When the turn finished, as an ISO time (UTC).
  timestamp: string;
  sessionId: string;
  // The configured provider's name, not the model's maker.
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // Room for later layers (cost, and so on); read back untouched.
  [extra: string]: unknown;
};

export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; turns: number };

// Read at call time, so a test can point the home folder elsewhere.
export const usageFile = () => path.join(os.homedir(), ".llama-mui", "usage.jsonl");

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// Turns anything parsed from a line into a record, or undefined if it isn't
// one. Missing counts are 0; other fields are kept.
export function toRecord(raw: unknown): UsageRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.timestamp !== "string" || Number.isNaN(Date.parse(r.timestamp))) return undefined;
  if (typeof r.sessionId !== "string" || typeof r.provider !== "string") return undefined;
  return {
    ...r,
    timestamp: r.timestamp,
    sessionId: r.sessionId,
    provider: r.provider,
    model: typeof r.model === "string" ? r.model : "",
    input: count(r.input),
    output: count(r.output),
    cacheRead: count(r.cacheRead),
    cacheWrite: count(r.cacheWrite),
  };
}

// Adds one line. The timestamp defaults to now.
export async function appendUsage(rec: Omit<UsageRecord, "timestamp"> & { timestamp?: string }): Promise<void> {
  const file = usageFile();
  const line = toRecord({ ...rec, timestamp: rec.timestamp ?? new Date().toISOString() });
  if (!line) throw new Error("A usage record needs a session id and a provider");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

// Every record in the file, oldest first. A missing file is empty; a line that
// can't be read (say, cut short by a crash) is skipped.
export async function readUsage(): Promise<UsageRecord[]> {
  let text: string;
  try {
    text = await readFile(usageFile(), "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = toRecord(JSON.parse(line));
      if (rec) out.push(rec);
    } catch {
      // skip
    }
  }
  return out;
}

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 });

// Total is input + output; cache counts are shown apart and not added in.
export function addTo(t: UsageTotals, r: UsageRecord): UsageTotals {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.total += r.input + r.output;
  t.turns += 1;
  return t;
}

export const sumAll = (records: UsageRecord[]): UsageTotals => records.reduce(addTo, emptyTotals());

export function sumBy(records: UsageRecord[], key: (r: UsageRecord) => string): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {};
  for (const r of records) addTo((out[key(r)] ??= emptyTotals()), r);
  return out;
}

// The local calendar day of a record, as YYYY-MM-DD.
export function dayOf(timestamp: string): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const sumBySession = (records: UsageRecord[]) => sumBy(records, (r) => r.sessionId);
export const sumByDay = (records: UsageRecord[]) => sumBy(records, (r) => dayOf(r.timestamp));
export const sumByProvider = (records: UsageRecord[]) => sumBy(records, (r) => r.provider);
