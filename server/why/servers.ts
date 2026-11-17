// The running servers, for the `why` command (see docs/guide.md).
//
// Read only, and not recovery code. A server counts as running when its log
// has a start line, no shutdown or close line after it, and its process
// number is alive. For each one it reports the page port, the API port, the
// process number, the start time from its log start line, and whether commits
// touching `server/` or `src/` landed since it started.
//
// A fact that can't be found is returned in `missing`, never guessed. The
// page/API pairing is read from the mode in the start line and the ports in
// the listening lines, using the pairs the app documents (AGENTS.md).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "../io/exec.ts";
import { defaultRoot } from "./chat.ts";

export interface ServerInfo {
  pid: number;
  mode: string | null;
  startedAt: number; // ms since epoch, from the start line
  pagePort: number | null;
  apiPort: number | null;
  codeChanged: boolean | null; // null = could not tell
  commits: number | null;
}

export interface ServersResult {
  servers: ServerInfo[];
  missing: string[];
}

// Which port serves the page (https) and which the API (plain http), per mode.
const PAIRS: Record<string, { page: number; api: number }> = {
  prod: { page: 5173, api: 5172 },
  dev: { page: 5175, api: 5174 },
};

export interface Deps {
  isAlive(pid: number): boolean;
  // Output of `git log --since=<iso> --format=%h -- server src`, or null if git failed.
  gitLog(since: string, repo: string): Promise<string | null>;
}

export const realDeps: Deps = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  async gitLog(since, repo) {
    try {
      const { stdout } = await execFile(
        "git",
        ["--no-pager", "log", `--since=${since}`, "--format=%h", "--", "server", "src"],
        { cwd: repo, timeout: 15000 },
        { why: "why.git-log" },
      );
      return stdout;
    } catch {
      return null;
    }
  },
};

interface Life {
  t: number;
  pid: number;
  event: string;
  rec: Record<string, unknown>;
}

async function readLife(root: string): Promise<Life[]> {
  const dir = path.join(root, "logs");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /^server-.*\.log$/.test(f)).sort();
  } catch {
    return [];
  }
  const out: Life[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"event":"server.')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec.event !== "string" || !/^server\.(start|listening|shutdown|close|force-close)$/.test(rec.event)) continue;
      const t = typeof rec.t === "string" ? Date.parse(rec.t) : NaN;
      if (!Number.isFinite(t) || typeof rec.pid !== "number") continue;
      out.push({ t, pid: rec.pid, event: rec.event, rec });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export async function collectServers(opts: { root?: string; repo?: string; deps?: Deps } = {}): Promise<ServersResult> {
  const root = opts.root ?? defaultRoot();
  const repo = opts.repo ?? process.cwd();
  const deps = opts.deps ?? realDeps;
  const missing: string[] = [];
  const life = await readLife(root);
  if (!life.length) return { servers: [], missing: ["No server start lines were found in any server log."] };

  const byPid = new Map<number, Life[]>();
  for (const l of life) byPid.set(l.pid, [...(byPid.get(l.pid) ?? []), l]);

  const servers: ServerInfo[] = [];
  let noId = false;
  for (const [pid, lines] of byPid) {
    // Only the latest start of this process number counts (numbers get reused).
    const startIdx = lines.map((l) => l.event).lastIndexOf("server.start");
    if (startIdx < 0) continue;
    const mine = lines.slice(startIdx);
    if (mine.some((l) => /^server\.(shutdown|close|force-close)$/.test(l.event))) continue;
    if (!deps.isAlive(pid)) continue;

    const start = mine[0];
    if (typeof start.rec.serverId !== "string") noId = true;
    const mode = typeof start.rec.mode === "string" ? start.rec.mode : null;
    const ports = mine.filter((l) => l.event === "server.listening" && typeof l.rec.port === "number").map((l) => l.rec.port as number);
    const pair = mode ? PAIRS[mode] : undefined;
    let pagePort: number | null = null;
    let apiPort: number | null = null;
    if (pair && ports.includes(pair.page)) pagePort = pair.page;
    if (pair && ports.includes(pair.api)) apiPort = pair.api;
    if (pagePort === null || apiPort === null) {
      const seen = ports.length ? `its log shows port ${[...new Set(ports)].join(", ")}` : "its log has no listening line";
      missing.push(`Server pid ${pid}: could not tell which port is the page and which is the API (${seen}).`);
    }

    let codeChanged: boolean | null = null;
    let commits: number | null = null;
    const out = await deps.gitLog(new Date(start.t).toISOString(), repo);
    if (out === null) missing.push(`Server pid ${pid}: git could not say whether code changed since it started.`);
    else {
      commits = out.split("\n").filter((l) => l.trim()).length;
      codeChanged = commits > 0;
    }
    servers.push({ pid, mode, startedAt: start.t, pagePort, apiPort, codeChanged, commits });
  }
  servers.sort((a, b) => a.startedAt - b.startedAt);
  if (!servers.length) missing.push("No server is listening: every start line in the logs has a shutdown or close after it, or its process is gone.");
  if (noId) missing.push("Server start lines carry no server id, so a run's owner is matched by port and process number only.");
  return { servers, missing };
}

export const describeServer = (s: ServerInfo): string =>
  `pid=${s.pid} mode=${s.mode ?? "?"} page=${s.pagePort ?? "?"} api=${s.apiPort ?? "?"} started=${new Date(s.startedAt).toISOString()} ` +
  `code changed since it started: ${s.codeChanged === null ? "unknown" : s.codeChanged ? `yes (${s.commits} commit${s.commits === 1 ? "" : "s"})` : "no"}`;
