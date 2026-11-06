import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

// Locks live under the home folder: point it at a temp one, never the real one.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { STALE_MS, isStale, locksDir, processAlive, withFileLock } = await import("../fileLock.ts");
const lockFile = (name: string) => path.join(locksDir(), `${name}.lock`);
const files = async () => (await readdir(locksDir()).catch(() => [])).sort();
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

describe("withFileLock", () => {
  it("holds the lock only while the work runs", async () => {
    await withFileLock("a", async () => {
      const info = JSON.parse(await readFile(lockFile("a"), "utf8"));
      expect(info.pid).toBe(process.pid);
    });
    expect(await files()).not.toContain("a.lock");
  });

  it("lets go when the work throws", async () => {
    await expect(withFileLock("b", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await files()).not.toContain("b.lock");
  });

  it("takes over a lock whose owner process is gone (a crash)", async () => {
    await mkdir(locksDir(), { recursive: true });
    await writeFile(lockFile("c"), JSON.stringify({ pid: deadPid(), token: "x", at: Date.now() }));
    await expect(withFileLock("c", async () => "ran")).resolves.toBe("ran");
    expect(await files()).not.toContain("c.lock");
  });

  it("takes over a lock that is too old, even if its pid is alive", async () => {
    await mkdir(locksDir(), { recursive: true });
    await writeFile(lockFile("d"), JSON.stringify({ pid: process.ppid, token: "x", at: Date.now() - STALE_MS - 1 }));
    await expect(withFileLock("d", async () => "ran")).resolves.toBe("ran");
  });

  it("takes over an empty lock file only after a while", async () => {
    await mkdir(locksDir(), { recursive: true });
    await writeFile(lockFile("e"), "");
    const old = new Date(Date.now() - STALE_MS - 1000);
    await utimes(lockFile("e"), old, old);
    await expect(withFileLock("e", async () => "ran")).resolves.toBe("ran");
  });

  it("says another process is updating when a live process holds it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mkdir(locksDir(), { recursive: true });
      await writeFile(lockFile("f"), JSON.stringify({ pid: process.ppid, token: "x", at: Date.now() }));
      const result = withFileLock("f", async () => "ran").catch((e) => e);
      await vi.advanceTimersByTimeAsync(4000);
      const err = await result;
      expect(err.status).toBe(503);
      expect(err.message).toMatch(/another llama-mui process is updating/i);
      // Not ours, so not deleted.
      expect(await files()).toContain("f.lock");
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't delete a lock that was taken over while it ran", async () => {
    await withFileLock("g", async () => {
      await writeFile(lockFile("g"), JSON.stringify({ pid: process.ppid, token: "someone-else", at: Date.now() }));
    });
    expect(JSON.parse(await readFile(lockFile("g"), "utf8")).token).toBe("someone-else");
  });

  it("rejects names that aren't plain", async () => {
    await expect(withFileLock("../x", async () => 1)).rejects.toThrow(/Bad lock name/);
  });
});

describe("staleness", () => {
  it("knows live and dead processes", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(deadPid())).toBe(false);
    expect(processAlive(undefined)).toBe(false);
    expect(processAlive(-1)).toBe(false);
  });
  it("counts a fresh lock of a live process as held", () => {
    expect(isStale({ pid: process.pid, token: "t", at: Date.now() }, Date.now())).toBe(false);
  });
});

describe("saving a session goes through the lock", () => {
  it("refuses with the 'another process' message while a live process holds the session's lock, and saves once it's gone", async () => {
    const hub = await import("../runHub.ts");
    const session = { id: "locked-one", title: "t", updatedAt: 1, messages: [], plan: [] };
    await mkdir(locksDir(), { recursive: true });
    // A lock held by a live process (the test runner's parent), as a second server's would be.
    await writeFile(lockFile("session-locked-one"), JSON.stringify({ pid: process.ppid, token: "x", at: Date.now() }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const attempt = hub.replace("locked-one", () => session).catch((e) => e);
      await vi.advanceTimersByTimeAsync(4000);
      expect((await attempt).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
    // The other process crashed: its lock is stale, and the save goes through.
    await writeFile(lockFile("session-locked-one"), JSON.stringify({ pid: deadPid(), token: "x", at: Date.now() }));
    const saved = await hub.replace("locked-one", () => session);
    expect(saved.revision).toBe(1);
    expect(await files()).not.toContain("session-locked-one.lock");
  });
});
