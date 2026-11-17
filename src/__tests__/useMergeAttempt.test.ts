import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMergeController } from "../useMergeAttempt";

let calls: { method: string; url: string; body?: unknown }[];
let states: string[];
const flush = () => vi.advanceTimersByTimeAsync(0);
const reply = (state: string) => new Response(JSON.stringify({ id: "a1", branch: "b", state, checks: [] }), { status: 200 });

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  states = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && url.endsWith("/merge")) return reply("replaying");
    if (method === "POST" && url.endsWith("/approve")) return reply("merged");
    if (method === "POST" && url.endsWith("/discard")) return reply("discarded");
    return reply(states.shift() ?? "ready");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createMergeController", () => {
  it("starts with the folder and branch, then polls every 2 seconds until ready", async () => {
    states = ["checking", "ready"];
    const seen: (string | undefined)[] = [];
    const ended = vi.fn();
    const c = createMergeController("/p", (s) => s && seen.push(s.state), ended);
    await c.start("b");
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/work-in-progress/merge", body: { dir: "/p", branch: "b" } });
    expect(ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls[1]).toMatchObject({ method: "GET", url: "/api/work-in-progress/merge/a1" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["replaying", "checking", "ready"]);
    expect(ended).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
    c.stop();
  });

  it("approve and discard call their routes and ask for a reload", async () => {
    states = ["ready"];
    const ended = vi.fn();
    const seen: (string | undefined)[] = [];
    const c = createMergeController("/p", (s) => s && seen.push(s.state), ended);
    await c.start("b");
    await vi.advanceTimersByTimeAsync(2000);
    ended.mockClear();
    await c.approve();
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/work-in-progress/merge/a1/approve" });
    expect(seen.at(-1)).toBe("merged");
    expect(ended).toHaveBeenCalledTimes(1);
    await c.discard();
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/work-in-progress/merge/a1/discard" });
    expect(seen.at(-1)).toBe("discarded");
    expect(ended).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it("reports a refused start and stops polling once stopped", async () => {
    const errors: (string | null)[] = [];
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Already running." }), { status: 409 }));
    const c = createMergeController("/p", (_s, e) => errors.push(e), vi.fn());
    await c.start("b");
    expect(errors.at(-1)).toBeTruthy();
    c.stop();
    await flush();
  });
});
