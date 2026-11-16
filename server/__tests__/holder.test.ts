import { describe, expect, it, vi } from "vitest";

const { holderOf, ownerNow, serverId, DEAD_AFTER_MS } = await import("../runRecord.ts");

const NOW = 1_000_000;

describe("who holds the floor", () => {
  it("a run this server owns is mine", () => {
    const run = { startedAt: 1, owner: { ...ownerNow(5175), checkedAt: NOW - 3000 } };
    expect(holderOf(run, NOW)).toEqual({ port: 5175, serverId, secondsSinceCheckIn: 3, mine: true });
  });

  it("another server's fresh record is not mine, and names its port", () => {
    const run = { startedAt: 1, owner: { pid: 9, port: 5173, checkedAt: NOW - 1000, serverId: "other" } };
    expect(holderOf(run, NOW)).toMatchObject({ port: 5173, serverId: "other", mine: false });
  });

  it("an older record without a server id is another holder", () => {
    const run = { startedAt: 1, owner: { pid: process.pid, port: 5173, checkedAt: NOW - 1000 } };
    expect(holderOf(run, NOW)).toMatchObject({ port: 5173, serverId: null, mine: false });
  });

  it("no run, no owner, or a dead owner gives nothing", () => {
    expect(holderOf(null, NOW)).toBeNull();
    expect(holderOf({}, NOW)).toBeNull();
    const dead = { startedAt: 1, owner: { ...ownerNow(5175), checkedAt: NOW - DEAD_AFTER_MS } };
    expect(holderOf(dead, NOW)).toBeNull();
  });

  it("a restarted server is a stranger to its old run", async () => {
    const run = { startedAt: 1, owner: { ...ownerNow(5175), checkedAt: NOW } };
    vi.resetModules();
    const restarted = await import("../runRecord.ts");
    expect(restarted.serverId).not.toBe(serverId);
    expect(holderOf(run, NOW, restarted.serverId)).toMatchObject({ port: 5175, mine: false });
    expect(restarted.holderOf(run, NOW)).toMatchObject({ mine: false });
  });
});
