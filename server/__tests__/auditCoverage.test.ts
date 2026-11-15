// Coverage checks for the audit log: they fail when something could act without leaving a line.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allToolNames, isAudited, toolSpecs } from "../tools";

const SERVER = path.resolve(__dirname, "..");

// Production source files in server/ (tests excluded), as [name, text].
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push([path.relative(SERVER, full), fs.readFileSync(full, "utf8")]);
    }
  };
  walk(SERVER);
  return out;
}

// The base layer: files that may use raw node APIs because the wrappers in server/io/ depend on
// them (or on the audit log), so auditing them would recurse. Each has a reason. Everything else
// outside server/io/ must go through the wrappers.
const RAW_ALLOWLIST: Record<string, string> = {
  "audit.ts": "writes the audit log itself; auditing it would recurse",
  "log.ts": "writes the server log itself; auditing it would recurse",
  "fileLock.ts": "the lock file that guards other writes; it holds no data and is made and removed at every locked save",
};

const MUTATORS = [
  "writeFile", "appendFile", "rename", "unlink", "mkdir", "rm", "rmdir", "copyFile", "cp", "open",
  "mkdtemp", "truncate", "symlink", "link", "createWriteStream", "writeSync", "ftruncate",
];
const MUTATOR_RE = new RegExp(`^(${MUTATORS.join("|")})(Sync)?$`);

// Rule breaks in one file's text: raw child_process, global fetch, or file-mutating node:fs imports.
export function rawIoBreaks(text: string): string[] {
  const out: string[] = [];
  if (/from\s+["'](node:)?child_process["']|(require|import)\(\s*["'](node:)?child_process["']\s*\)/.test(text))
    out.push(
      "imports node:child_process. Use execFile or spawn from server/io/exec.ts (import { execFile } from \"./io/exec\") with a `why`.",
    );
  if (/(^|[^.\w$])fetch\s*\(|globalThis\.fetch|\bwindow\.fetch/m.test(text.replace(/\/\/.*$/gm, "")))
    out.push("calls the global fetch. Use auditedFetch from server/io/fetch.ts (import { auditedFetch } from \"./io/fetch\") with a `why`.");
  const fsImport = /import\s+(type\s+)?([^;]*?)\s+from\s+["'](node:)?fs(\/promises)?["']/g;
  for (const m of text.matchAll(fsImport)) {
    if (m[1]) continue;
    const clause = m[2];
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    const names = named.split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
    const bad = names.filter((n) => MUTATOR_RE.test(n));
    const nonNamed = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
    if (nonNamed) bad.push(`${nonNamed} (a whole-module import hides which calls are made)`);
    if (bad.length)
      out.push(
        `imports file-mutating ${bad.join(", ")} from node:fs. Use write, append, rename, remove or mkdir from server/io/fs.ts (import { write } from "./io/fs") with a \`why\`.`,
      );
  }
  if (/require\(\s*["'](node:)?fs(\/promises)?["']\s*\)/.test(text))
    out.push("requires node:fs. Import only reads from node:fs, and use the wrappers in server/io/fs.ts for writes.");
  return out;
}

// Calls to .run( that are not tool calls, reviewed one by one.
const NON_TOOL_RUN_CALLS = [
  ".run(callbacks)", // the plan runner in runners.ts
  "store.run({ ...store.getStore()", // AsyncLocalStorage.run in auditContext.ts, not a tool
];

describe("audit coverage", () => {
  it("wraps every tool in the registry", () => {
    const names = allToolNames();
    expect(names.length).toBeGreaterThan(0);
    const unwrapped = toolSpecs()
      .filter((t) => !isAudited(t))
      .map((t) => t.name);
    expect(
      unwrapped,
      `These tools are not wrapped by withAudit, so their calls would go unlogged: ${unwrapped.join(", ")}. ` +
        `Build the registry only through withAudit in server/tools.ts.`,
    ).toEqual([]);
    expect(new Set(names).size, "tool names must be unique").toBe(names.length);
  });

  it("lets only tools.ts call a tool's run", () => {
    const offenders: string[] = [];
    for (const [file, text] of sources()) {
      if (file === "tools.ts") continue;
      text.split("\n").forEach((line, i) => {
        if (!/\.run\(/.test(line)) return;
        if (NON_TOOL_RUN_CALLS.some((ok) => line.includes(ok))) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `Only runTool in server/tools.ts may call a tool's run; elsewhere the call bypasses the audit log. ` +
        `Go through runTool, or if this is not a tool call add its exact text to NON_TOOL_RUN_CALLS with a reason.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the allowlist entries real, each with a reason", () => {
    const files = sources().map(([f]) => f);
    for (const [file, reason] of Object.entries(RAW_ALLOWLIST)) {
      expect(files, `${file} is allowlisted but missing; remove it from RAW_ALLOWLIST`).toContain(file);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("lets only server/io/ and the allowlist use raw exec, fetch and file writes", () => {
    const offenders: string[] = [];
    for (const [file, text] of sources()) {
      if (file.startsWith("io/") || file in RAW_ALLOWLIST) continue;
      for (const b of rawIoBreaks(text)) offenders.push(`${file}: ${b}`);
    }
    expect(
      offenders,
      `These files bypass the audited wrappers in server/io/, so what they do would go unlogged:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("catches each kind of break (the rule itself works)", () => {
    expect(rawIoBreaks('import { spawn } from "node:child_process";')).toHaveLength(1);
    expect(rawIoBreaks('const cp = require("child_process");')).toHaveLength(1);
    expect(rawIoBreaks("const r = await fetch(url);")).toHaveLength(1);
    expect(rawIoBreaks("await globalThis.fetch(url);")).toHaveLength(1);
    expect(rawIoBreaks('import { readFile, writeFile } from "node:fs/promises";')).toHaveLength(1);
    expect(rawIoBreaks('import {\n  readFile,\n  rm as remove,\n} from "node:fs/promises";')).toHaveLength(1);
    expect(rawIoBreaks('import { appendFileSync } from "node:fs";')).toHaveLength(1);
    expect(rawIoBreaks('import fs from "node:fs";')).toHaveLength(1);
    expect(rawIoBreaks('import { readFile, stat, readdir } from "node:fs/promises";')).toEqual([]);
    expect(rawIoBreaks('import type { Dirent } from "node:fs";')).toEqual([]);
    expect(rawIoBreaks("await auditedFetch(url, {}, { why: 'x' }); res.fetch(1);")).toEqual([]);
  });
});
