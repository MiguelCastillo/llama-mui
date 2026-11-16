import { afterEach, describe, expect, it, vi } from "vitest";

// Point the home folder at a temp one: these tests must never touch ~/.llama-mui.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const { ownerAlive, CHECK_IN_MS, DEAD_AFTER_MS, fileRunStore } = await import("../runRecord.ts");
const hub = await import("../runHub.ts");
const { writeSession } = await import("../sessionFile.ts");

const rec = (checkedAt: number) => ({ startedAt: 0, owner: { pid: 1, port: 5173, checkedAt } });

describe("owner liveness", () => {
  it("a fresh check-in is alive and a 21 second old one is dead", () => {
    const now = 1_000_000;
    expect(ownerAlive(rec(now), now)).toBe(true);
    expect(ownerAlive(rec(now - 19_000), now)).toBe(true);
    expect(ownerAlive(rec(now - 21_000), now)).toBe(false);
    expect(DEAD_AFTER_MS).toBe(20_000);
  });

  it("a record with no owner, or no record, is not alive", () => {
    expect(ownerAlive({ startedAt: 0 } as any, 5)).toBe(false);
    expect(ownerAlive(null, 5)).toBe(false);
  });
});

describe("check-in while a run is live", () => {
  afterEach(() => vi.useRealTimers());

  it("refreshes the record every 5 seconds and stops when the run ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(10_000);
    await writeSession("hb", { id: "hb", messages: [] });
    await hub.beginRun("hb");
    expect((await fileRunStore.read("hb"))!.owner!.checkedAt).toBe(10_000);

    await vi.advanceTimersByTimeAsync(CHECK_IN_MS);
    await hub.locked("hb", async () => {});
    expect((await fileRunStore.read("hb"))!.owner!.checkedAt).toBe(10_000 + CHECK_IN_MS);
    expect(ownerAlive(await fileRunStore.read("hb"), Date.now())).toBe(true);

    await hub.endRun("hb");
    expect(vi.getTimerCount()).toBe(0);
    expect(await fileRunStore.read("hb")).toBeNull();
  });
});
