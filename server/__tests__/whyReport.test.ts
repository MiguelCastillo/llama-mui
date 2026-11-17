import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, windowAt } from "../why/report";
import type { Deps } from "../why/servers";

const j = (o: object) => JSON.stringify(o);
const ID = "aaaa1111-2222-3333-4444-555566667777";
const NOW = Date.parse("2026-11-17T11:00:00.000Z");

function fixture() {
  const r = mkdtempSync(path.join(os.tmpdir(), "why-rep-"));
  mkdirSync(path.join(r, "sessions", ID), { recursive: true });
  mkdirSync(path.join(r, "logs"));
  mkdirSync(path.join(r, "audit"));
  writeFileSync(
    path.join(r, "sessions", ID, "session.json"),
    j({
      id: ID,
      title: "Approval buttons only on the owner",
      endedBy: "restart",
      messages: [{ role: "user", content: "SECRET-MESSAGE-TEXT" }],
      plan: [
        { summary: "Do the thing", status: "done", note: "ok" },
        { summary: "Do the next thing", status: "paused", note: "Paused" },
      ],
      run: { kind: "plan", status: "paused", owner: { port: 5172, pid: 10, serverId: null, checkedAt: NOW - 90000 } },
    }),
  );
  writeFileSync(
    path.join(r, "logs", "server-2026-11-17.log"),
    [
      { t: "2026-11-17T10:00:00.000Z", pid: 10, event: "server.start", mode: "prod" },
      { t: "2026-11-17T10:00:01.000Z", pid: 10, event: "server.listening", port: 5172 },
      { t: "2026-11-17T10:00:01.000Z", pid: 10, event: "server.listening", port: 5173 },
      { t: "2026-11-17T10:48:00.000Z", pid: 10, event: "server.close", reason: "reload", runs: [{ session: ID }] },
    ]
      .map(j)
      .join("\n"),
  );
  writeFileSync(
    path.join(r, "audit", "audit-2026-11-17.log"),
    j({ t: "2026-11-17T10:47:30.000Z", pid: 10, event: "run.abort", session: ID, prompt: "SECRET-PROMPT" }),
  );
  return r;
}

const deps: Deps = { isAlive: () => true, gitLog: async () => "" };

describe("why: report", () => {
  it("explains a chat ended by a restart, with all five sections", async () => {
    const text = await buildReport(ID, { root: fixture(), now: NOW, deps });
    for (const h of ["Chat", "Run record", "Timeline", "Servers", "Missing"]) expect(text).toMatch(new RegExp(`^${h}`, "m"));
    expect(text).toContain("ended by (saved apart from the run): restart");
    expect(text).toContain("2. [paused] Do the next thing (note: Paused)");
    expect(text).toContain("owner: port=5172 serverId=? pid=10");
    expect(text).toContain("90 seconds");
    expect(text).toContain("server.close reason=reload");
    expect(text).toContain("run.abort");
    expect(text).toContain("No run started or ended events for this chat in any log.");
    expect(text).toContain("The run record has no server id");
    expect(text).not.toContain("SECRET");
  });

  it("lists matches when title words are ambiguous, and says so when none match", async () => {
    const r = fixture();
    expect(await buildReport("nothing-like-this", { root: r, now: NOW, deps })).toMatch(/No chat matches/);
    expect(await buildReport("Approval buttons", { root: r, now: NOW, deps })).toContain(ID);
  });

  it("keeps lines outside the --at window out, and reports a bad time", async () => {
    const r = fixture();
    const near = await buildReport(ID, { root: r, now: NOW + 3600000, at: "10:48", deps });
    expect(near).toBeTypeOf("string");
    const bad = await buildReport(ID, { root: r, now: NOW, at: "banana", deps });
    expect(bad).toContain('"banana" is not a time');
  });

  it("parses HH:MM into a five-minute window, never in the future", () => {
    const w = windowAt("10:48", Date.now())!;
    expect(w.to - w.from).toBe(600000);
    expect(w.to).toBeLessThanOrEqual(Date.now() + 300000);
    expect(windowAt("25:00", Date.now())).toBeNull();
  });
});
