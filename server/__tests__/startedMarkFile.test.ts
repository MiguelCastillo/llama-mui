// The started mark on a tool call survives the server's file paths unchanged:
// a plain save, a save with fsync, and the read that normalises the file.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const hub = await import("../runHub.ts");
const { readSession, writeSession, sessionFile } = await import("../sessionFile.ts");

const messages = [
  { role: "user", content: "go" },
  { role: "assistant", content: "", toolCalls: [{ id: "a", name: "run_command", arguments: "{}", started: true }, { id: "b", name: "read_file", arguments: "{}" }] },
  { role: "tool", content: "ok", toolCallId: "a" },
  { role: "tool", content: "ok", toolCallId: "b" },
];
const base = (id: string) => ({ id, title: id, updatedAt: 1, createdAt: 1, messages });

describe("started mark in the session file", () => {
  it("reads back unchanged after a plain write and after a write with fsync", async () => {
    for (const [id, sync] of [["plain", false], ["synced", true]] as const) {
      await writeSession(id, base(id), { sync });
      expect((await readSession(id)).messages).toEqual(messages);
    }
  });

  it("is kept by the run's save (with fsync) and by a chat that already holds it", async () => {
    await mkdir(path.dirname(sessionFile("run")), { recursive: true });
    await writeFile(sessionFile("run"), JSON.stringify({ ...base("run"), messages: messages.slice(0, 1), revision: 1 }));
    await hub.save("run", { ...base("run"), revision: 1 } as any, { sync: true });
    const onDisk = JSON.parse(await readFile(sessionFile("run"), "utf8"));
    expect(onDisk.messages).toEqual(messages);
    expect((await readSession("run")).messages[1].toolCalls[0].started).toBe(true);
  });

  it("a chat saved without the mark still loads, with no mark added", async () => {
    const old = messages.map((m) => (m.toolCalls ? { ...m, toolCalls: m.toolCalls.map(({ started: _s, ...c }: any) => c) } : m));
    await writeSession("old", { ...base("old"), messages: old });
    expect((await readSession("old")).messages).toEqual(old);
  });
});
