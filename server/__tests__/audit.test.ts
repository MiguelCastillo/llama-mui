import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audit, auditDir, KEEP_DAYS, pruneAudit, whoOf } from "../audit";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "audit-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const lines = () => readdirSync(auditDir()).flatMap((f) => readFileSync(path.join(auditDir(), f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

describe("audit", () => {
  it("appends one JSON line with t, pid, event and the fields", () => {
    audit("tool.call", { tool: "x" });
    audit("api.request", { status: 200 });
    const got = lines();
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ pid: process.pid, event: "tool.call", tool: "x" });
    expect(new Date(got[0].t).toISOString()).toBe(got[0].t);
  });

  it("names the file by UTC day and keeps old days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T23:59:00Z"));
    audit("a");
    vi.setSystemTime(new Date("2030-01-02T00:01:00Z"));
    audit("b");
    expect(readdirSync(auditDir()).sort()).toEqual(["audit-2030-01-01.log", "audit-2030-01-02.log"]);
  });

  it("uses mode 0700 for the folder and 0600 for the file", () => {
    audit("a");
    expect(statSync(auditDir()).mode & 0o777).toBe(0o700);
    const f = path.join(auditDir(), readdirSync(auditDir())[0]);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("swallows failures", () => {
    writeFileSync(path.join(home, ".llama-mui"), "a file, not a folder");
    expect(() => audit("a", { n: 1 })).not.toThrow();
    const circular: any = {};
    circular.self = circular;
    expect(() => audit("b", circular)).not.toThrow();
  });
});

describe("pruneAudit", () => {
  const put = (day: string) => {
    mkdirSync(auditDir(), { recursive: true });
    writeFileSync(path.join(auditDir(), `audit-${day}.log`), "{}\n");
  };

  it("removes files older than KEEP_DAYS, keeps recent ones, and writes the pruned line", () => {
    const now = new Date("2030-06-01T12:00:00Z");
    const old = new Date(now.getTime() - (KEEP_DAYS + 1) * 86400000).toISOString().slice(0, 10);
    const edge = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    put(old);
    put(edge);
    put("2030-05-31");
    writeFileSync(path.join(auditDir(), "notes.txt"), "not an audit file");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(pruneAudit(now)).toEqual([`audit-${old}.log`]);
    const left = readdirSync(auditDir());
    expect(left).not.toContain(`audit-${old}.log`);
    expect(left).toContain(`audit-${edge}.log`);
    expect(left).toContain("audit-2030-05-31.log");
    expect(left).toContain("notes.txt");
    const pruned = readFileSync(path.join(auditDir(), "audit-2030-06-01.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toMatchObject({ event: "audit.pruned", files: [`audit-${old}.log`] });
  });

  it("writes nothing when there is nothing to remove, or no folder", () => {
    expect(pruneAudit()).toEqual([]);
    put("2030-05-31");
    expect(pruneAudit(new Date("2030-06-01T00:00:00Z"))).toEqual([]);
    expect(readdirSync(auditDir())).toEqual(["audit-2030-05-31.log"]);
  });
});

describe("whoOf", () => {
  it("returns the address and the first 80 characters of the user-agent", () => {
    const who = whoOf({ socket: { remoteAddress: "127.0.0.1" }, headers: { "user-agent": "x".repeat(200) } } as any);
    expect(who).toEqual({ address: "127.0.0.1", agent: "x".repeat(80) });
  });
  it("copes with missing parts", () => {
    expect(whoOf({ socket: {}, headers: {} } as any)).toEqual({ address: "", agent: "" });
  });
});
