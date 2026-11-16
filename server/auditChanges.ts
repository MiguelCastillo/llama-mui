// What the audit log saw one chat change in the files, for the note a restart
// leaves on an interrupted step. Best effort: anything that can't be read gives
// an empty list. Only lines that carry this chat's id are looked at.

import { readFileSync } from "node:fs";
import path from "node:path";
import { auditDir } from "./audit.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// Paths of the files `io.fs` lines show changed for chat `id` at or after
// `since` (ms), oldest first, each once. Reads the files of the day the run
// started, yesterday and today. A change that failed (the line has an error)
// is not counted. Never throws.
export function filesChangedSince(id: string, since: number, now: number = Date.now()): string[] {
  try {
    const days = new Set([since, now - DAY_MS, now].map((t) => new Date(t).toISOString().slice(0, 10)));
    const found: { t: number; path: string }[] = [];
    for (const day of [...days].sort()) {
      let text: string;
      try {
        text = readFileSync(path.join(auditDir(), `audit-${day}.log`), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.includes(id) || !line.includes("io.fs")) continue;
        try {
          const e = JSON.parse(line);
          if (e.event !== "io.fs" || e.session !== id || e.error !== undefined || typeof e.path !== "string") continue;
          const t = Date.parse(e.t);
          if (!(t >= since)) continue;
          found.push({ t, path: e.path });
        } catch {
          // A half-written last line.
        }
      }
    }
    return [...new Set(found.sort((a, b) => a.t - b.t).map((f) => f.path))];
  } catch {
    return [];
  }
}
