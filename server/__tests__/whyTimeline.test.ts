import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectTimeline } from "../why/timeline";

const ID = "aaaa1111-2222-3333-4444-555566667777";
const j = (o: object) => JSON.stringify(o);

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "why-tl-"));
  mkdirSync(path.join(root, "logs"));
  mkdirSync(path.join(root, "audit"));
  writeFileSync(
    path.join(root, "logs", "server-2026-11-17.log"),
    [
      j({ t: "2026-11-17T10:00:00.000Z", pid: 1, event: "server.start", mode: "prod", cwd: "/secret/path" }),
      j({ t: "2026-11-17T10:45:00.000Z", pid: 2, event: "server.start", mode: "dev" }),
      j({ t: "2026-11-17T10:48:00.000Z", pid: 1, event: "server.close", runs: [ID], reason: "reload" }),
      j({ t: "2026-11-17T10:49:00.000Z", pid: 3, event: "server.start", mode: "dev" }),
      j({ t: "2026-11-17T10:30:00.000Z", pid: 1, event: "chat.note", session: ID, prompt: "SECRET PROMPT", apiKey: "sk-123" }),
      "not json " + ID,
    ].join("\n"),
  );
  writeFileSync(
    path.join(root, "audit", "audit-2026-11-17.log"),
    [
      j({ t: "2026-11-17T10:47:00.000Z", pid: 1, event: "run.abort", session: ID, kind: "restart", command: "rm -rf /", text: "reply text here" }),
      j({ t: "2026-11-17T10:20:00.000Z", pid: 2, event: "run.abort", session: "other-chat", kind: "stopped" }),
    ].join("\n"),
  );
  return root;
}

describe("collectTimeline", () => {
  it("sorts chat lines and lifecycle lines of involved processes by time", async () => {
    const r = await collectTimeline(ID, { root: fixture() });
    expect(r.entries.map((e) => `${e.pid}:${e.event}`)).toEqual([
      "1:server.start",
      "1:chat.note",
      "1:run.abort",
      "1:server.close",
    ]);
    expect(r.pids).toEqual([1]);
  });

  it("keeps only chat lines inside the window, and lifecycle lines of the processes left", async () => {
    const root = fixture();
    const win = { from: Date.parse("2026-11-17T10:43:00Z"), to: Date.parse("2026-11-17T10:53:00Z") };
    const r = await collectTimeline(ID, { root, window: win });
    expect(r.entries.map((e) => e.event)).toEqual(["server.start", "run.abort", "server.close"]);
  });

  it("never prints prompts, text, commands, paths or keys", async () => {
    const r = await collectTimeline(ID, { root: fixture() });
    const all = r.entries.map((e) => e.line).join("\n");
    for (const bad of ["SECRET PROMPT", "sk-123", "reply text", "rm -rf", "/secret/path"]) expect(all).not.toContain(bad);
    expect(all).toContain("kind=restart");
    expect(all).toContain("reason=reload");
  });

  it("reports what is missing", async () => {
    const r = await collectTimeline(ID, { root: fixture() });
    expect(r.missing.join(" ")).toContain("No run started or ended events");
    expect(r.missing.join(" ")).toContain("No settle event");
    const none = await collectTimeline("zzzz", { root: fixture() });
    expect(none.entries).toEqual([]);
    expect(none.missing[0]).toContain("carries this chat's id");
  });

  it("takes extra sources from a list", async () => {
    const extra = { name: "extra", read: async () => ({ chat: [{ t: "2026-11-17T11:00:00.000Z", pid: 9, event: "run.start", session: ID }], lifecycle: [] }) };
    const r = await collectTimeline(ID, { root: fixture(), sources: [extra] });
    expect(r.entries.map((e) => e.source)).toEqual(["extra"]);
  });
});
