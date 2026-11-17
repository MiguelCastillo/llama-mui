import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findChat } from "../why/chat.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "llama-mui-why-"));
const NOW = 1_700_000_000_000;

function save(id: string, extra: Record<string, unknown> = {}) {
  mkdirSync(path.join(root, "sessions", id), { recursive: true });
  writeFileSync(
    path.join(root, "sessions", id, "session.json"),
    JSON.stringify({ id, title: `Chat ${id}`, updatedAt: NOW, messages: [{ role: "user", content: "SECRET MESSAGE TEXT" }], ...extra }),
  );
}

beforeAll(() => {
  save("parent-1", {
    title: "Approval buttons appear only on the server that holds the run",
    threads: [{ sessionId: "child-1", summary: "Build the tool", status: "unfinished" }],
  });
  save("child-1", {
    title: "Thread",
    parentId: "parent-1",
    endedBy: "restart",
    failed: null,
    queue: [{ id: "q", text: "SECRET QUEUED TEXT" }],
    queuePaused: true,
    plan: [
      { id: "a", text: "SECRET STEP TEXT", summary: "Add module", status: "done" },
      { id: "b", text: "x", summary: "Add source", status: "pending", note: "Paused" },
    ],
    run: {
      startedAt: NOW - 60_000,
      status: "running",
      owner: { pid: 42, port: 5172, checkedAt: NOW - 7_400, serverId: "srv-a" },
    },
  });
  save("plain-1", { title: "Other chat about gardens", userName: "Gardens" });
  save("plain-2", { title: "More gardens", updatedAt: NOW + 5 });
});

describe("findChat", () => {
  it("finds a chat by id with its saved facts", async () => {
    const r = await findChat("child-1", root, NOW);
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    const c = r.chat;
    expect(c.parentId).toBe("parent-1");
    expect(c.thread).toEqual({ parentId: "parent-1", parentTitle: "Approval buttons appear only on the server that holds the run", summary: "Build the tool", outcome: "unfinished" });
    expect(c.endedBy).toBe("restart");
    expect(c.failed).toBeNull();
    expect(c.queue).toEqual({ length: 1, paused: true });
    expect(c.plan).toEqual([
      { n: 1, status: "done", summary: "Add module", note: null },
      { n: 2, status: "pending", summary: "Add source", note: "Paused" },
    ]);
    expect(c.run).toEqual({
      status: "running",
      kind: "plan",
      startedAt: NOW - 60_000,
      endedBy: null,
      owner: { port: 5172, pid: 42, serverId: "srv-a", checkedAt: NOW - 7_400 },
      checkInAgeSeconds: 7,
    });
  });

  it("never returns message, step or queued text", async () => {
    const r = await findChat("child-1", root, NOW);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });

  it("lists a chat's threads from the parent", async () => {
    const r = await findChat("parent-1", root, NOW);
    expect(r.kind === "found" && r.chat.threads).toEqual([{ sessionId: "child-1", summary: "Build the tool", outcome: "unfinished" }]);
  });

  it("finds a chat by title words, in any case and order", async () => {
    const r = await findChat("holds RUN approval", root, NOW);
    expect(r.kind === "found" && r.chat.id).toBe("parent-1");
  });

  it("finds a chat by the start of its id", async () => {
    const r = await findChat("child-", root, NOW);
    expect(r.kind === "found" && r.chat.id).toBe("child-1");
  });

  it("lists several matches, newest first, and chooses none", async () => {
    const r = await findChat("gardens", root, NOW);
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.matches.map((m) => m.id)).toEqual(["plain-2", "plain-1"]);
    expect(r.matches[1].title).toBe("Gardens");
  });

  it("says missing when nothing matches or the query is empty", async () => {
    expect((await findChat("no such words here", root, NOW)).kind).toBe("missing");
    expect((await findChat("  ", root, NOW)).kind).toBe("missing");
    expect((await findChat("../etc", path.join(root, "nowhere"), NOW)).kind).toBe("missing");
  });

  it("returns run: null for a chat with no run record", async () => {
    const r = await findChat("plain-1", root, NOW);
    expect(r.kind === "found" && r.chat.run).toBeNull();
    expect(r.kind === "found" && r.chat.plan).toBeNull();
    expect(r.kind === "found" && r.chat.queue).toEqual({ length: 0, paused: false });
  });
});
