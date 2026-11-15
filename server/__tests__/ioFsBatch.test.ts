import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// Home is a temp folder before anything loads: never the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const fsio = await import("../io/fs.ts");
const { auditDir } = await import("../audit.ts");
const { runWithCause } = await import("../auditContext.ts");

const all = () =>
  (existsSync(auditDir()) ? readdirSync(auditDir()) : [])
    .sort()
    .map((f) => readFileSync(path.join(auditDir(), f), "utf8"))
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const batches = () => all().filter((l) => l.event === "io.fs.batch");

const work = realpathSync(mkdtempSync(path.join(home.dir, "work-")));

describe("io/fs batched mode", () => {
  it("writes the file as it should and counts many writes in one line", async () => {
    const file = path.join(work, "deep", "session.json");
    for (let i = 0; i < 5; i++) await fsio.writeAtomicBatched(file, `{"n":${i}}`, { mode: 0o600, dirMode: 0o700 }, { why: "t.save" });
    expect(readFileSync(file, "utf8")).toBe('{"n":4}');
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(batches()).toEqual([]); // nothing yet: the minute is not up
    fsio.flushBatches();
    const lines = batches();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ why: "t.save", path: file, count: 5, bytes: 35 });
    expect(JSON.stringify(lines[0])).not.toContain('"n"'); // never the content
    // Flushed once: a second flush adds nothing.
    fsio.flushBatches();
    expect(batches()).toHaveLength(1);
  });

  it("appends and keeps one line per path", async () => {
    const a = path.join(work, "a.jsonl");
    const b = path.join(work, "b.jsonl");
    await fsio.appendBatched(a, "xx\n", { mode: 0o600 }, { why: "t.log" });
    await fsio.appendBatched(a, "yy\n", { mode: 0o600 }, { why: "t.log" });
    await fsio.appendBatched(b, "z\n", { mode: 0o600 }, { why: "t.log" });
    expect(readFileSync(a, "utf8")).toBe("xx\nyy\n");
    const before = batches().length;
    fsio.flushBatches();
    const added = batches().slice(before);
    expect(added.map((l) => [l.path, l.count, l.bytes]).sort()).toEqual([[a, 2, 6], [b, 1, 2]]);
  });

  it("gives each chat its own line for a file they share", async () => {
    const file = path.join(work, "usage.jsonl");
    const w = (s: string) => runWithCause({ session: s, call: "c1" }, () => fsio.appendBatched(file, "u\n", {}, { why: "t.shared" }));
    await w("chat-a");
    await w("chat-a");
    await w("chat-b");
    await fsio.appendBatched(file, "u\n", {}, { why: "t.shared" }); // no chat
    const before = batches().length;
    fsio.flushBatches();
    const added = batches().slice(before);
    expect(added).toHaveLength(3);
    const by = (s?: string) => added.find((l) => l.session === s);
    expect(by("chat-a")).toMatchObject({ path: file, count: 2, bytes: 4 });
    expect(by("chat-b")).toMatchObject({ path: file, count: 1, bytes: 2 });
    expect(by(undefined)).toMatchObject({ count: 1 });
    expect(added.some((l) => l.call)).toBe(false); // the summary has no single call
  });

  it("takes the chat from a sessions/<id>/ path when there is no cause", async () => {
    const file = path.join(work, "sessions", "abc123", "session.json");
    await fsio.writeAtomicBatched(file, "{}", {}, { why: "t.path" });
    const before = batches().length;
    fsio.flushBatches();
    expect(batches().slice(before)).toMatchObject([{ session: "abc123", path: file, count: 1 }]);
  });

  it("flushes by itself after a minute", async () => {
    vi.useFakeTimers();
    try {
      const file = path.join(work, "timer.jsonl");
      await fsio.appendBatched(file, "t\n", {}, { why: "t.timer" });
      const before = batches().length;
      await vi.advanceTimersByTimeAsync(fsio.BATCH_MS + 1);
      expect(batches().slice(before)).toMatchObject([{ path: file, count: 1, bytes: 2 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes when the process exits", async () => {
    const file = path.join(work, "exit.jsonl");
    await fsio.appendBatched(file, "e\n", {}, { why: "t.exit" });
    const before = batches().length;
    // The exit listener the module registered; calling it is what the exit does.
    const listener = process.listeners("exit").find((l) => l === fsio.flushBatches);
    expect(listener).toBeDefined();
    listener!(0);
    expect(batches().slice(before)).toMatchObject([{ path: file, count: 1, bytes: 2, why: "t.exit" }]);
  });

  it("logs a failed write at once with its error and does not count it", async () => {
    const file = path.join(work, "blocker");
    await fsio.write(file, "i am a file", undefined, { why: "t.setup" });
    const bad = path.join(file, "child.json"); // its folder is a file
    await expect(fsio.writeAtomicBatched(bad, "x", {}, { why: "t.bad" })).rejects.toThrow();
    expect(all().filter((l) => l.event === "io.fs" && l.why === "t.bad").at(-1)).toMatchObject({ op: "write", path: bad });
    fsio.flushBatches();
    expect(batches().filter((l) => l.why === "t.bad")).toEqual([]);
  });
});
