import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The audit is write-only for the app. Recovery (deciding whether a run is live,
// settling a dead one, the interrupted note) works from the run record alone and
// must never import the audit module or read audit files. See AGENTS.md.

const serverDir = path.resolve(__dirname, "..");
const read = (name: string) => readFileSync(path.join(serverDir, name), "utf8");

// Whole files that are recovery code. Add a file here when it joins recovery.
const RECOVERY_FILES = ["restart.ts", "runRecord.ts", "sessionWatch.ts", "changedFiles.ts"];

const IMPORTS_AUDIT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*\/audit(?:Context)?(?:\.ts|\.js)?["']/;
const TOUCHES_AUDIT_FILES = /auditDir|pruneAudit|["'`]audit["'`]|audit-|\.llama-mui\/audit/;

// The part of a file from `export function <name>` to the next top-level export.
function functionSource(file: string, name: string): string {
  const src = read(file);
  const start = src.search(new RegExp(`export (?:async )?function ${name}\\b`));
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:export|function|async function) /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("recovery never reads the audit", () => {
  for (const file of RECOVERY_FILES) {
    it(`${file} does not import the audit or touch audit files`, () => {
      const src = read(file);
      expect(src, `${file} imports audit`).not.toMatch(IMPORTS_AUDIT);
      expect(src, `${file} mentions audit files`).not.toMatch(TOUCHES_AUDIT_FILES);
    });
  }

  it("settleStale (in the run hub, which may write the audit elsewhere) does not use it", () => {
    const body = functionSource("runHub.ts", "settleStale");
    expect(body).not.toMatch(/\baudit\w*\s*\(/);
    expect(body).not.toMatch(TOUCHES_AUDIT_FILES);
  });

  it("the run hub only imports the write-only audit function it needs", () => {
    const imports = read("runHub.ts").match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/audit\.ts["']/);
    const names = (imports?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    expect(names.filter((n) => n !== "auditSessionDeleted")).toEqual([]);
  });

  it("the check itself catches an import of the audit", () => {
    expect('import { audit } from "./audit.ts";').toMatch(IMPORTS_AUDIT);
    expect('const m = await import("./audit.ts");').toMatch(IMPORTS_AUDIT);
    expect('import { x } from "./runRecord.ts";').not.toMatch(IMPORTS_AUDIT);
  });
});
