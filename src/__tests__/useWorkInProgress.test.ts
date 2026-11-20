import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppEvents } from "../appEvents";
import { watchWorkInProgress } from "../useWorkInProgress";

class FakeSource {
  static all: FakeSource[] = [];
  listeners: Record<string, ((e: Event) => void)[]> = {};
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(t: string, f: (e: Event) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener(t: string, f: (e: Event) => void) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f);
  }
  emit(t: string, data: unknown) {
    for (const f of this.listeners[t] ?? []) f({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {}
}

let calls: string[];
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  calls = [];
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify([{ kind: "loose", name: "n" }]), { status: 200 });
  });
});
afterEach(() => {
  resetAppEvents();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("watchWorkInProgress", () => {
  it("loads at once for the folder, then every interval", async () => {
    const seen = vi.fn();
    const stop = watchWorkInProgress("/p/my proj", seen, 1000);
    await flush();
    expect(calls).toEqual(["/api/work-in-progress?dir=%2Fp%2Fmy%20proj"]);
    expect(seen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    stop();
  });

  it("refreshes right after a run ends, not while one is running", async () => {
    const stop = watchWorkInProgress("/p", () => {}, 60_000);
    await flush();
    FakeSource.all[0].emit("status", { run: { id: "x" } });
    await flush();
    expect(calls).toHaveLength(1);
    FakeSource.all[0].emit("status", { run: null });
    await flush();
    expect(calls).toHaveLength(2);
    stop();
  });

  it("reloads when the server says work changed", async () => {
    const stop = watchWorkInProgress("/p", () => {}, 600_000);
    await flush();
    FakeSource.all[0].emit("work", {});
    await flush();
    expect(calls).toHaveLength(2);
    stop();
  });

  it("removes the work listener on stop", async () => {
    const stop = watchWorkInProgress("/p", () => {}, 600_000);
    await flush();
    expect(FakeSource.all[0].listeners["work"]).toHaveLength(1);
    stop();
    expect(FakeSource.all[0].listeners["work"]).toHaveLength(0);
    FakeSource.all[0].emit("work", {});
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("uses a 60 second timer by default, not 15", async () => {
    const stop = watchWorkInProgress("/p", () => {});
    await flush();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    stop();
  });

  it("stops refreshing once stopped", async () => {
    const stop = watchWorkInProgress("/p", () => {}, 1000);
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
  });

  it("skips timed refreshes while the page is hidden", async () => {
    const stop = watchWorkInProgress("/p", () => {}, 1000);
    await flush();
    vi.stubGlobal("document", { visibilityState: "hidden", addEventListener() {}, removeEventListener() {} });
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(1);
    stop();
  });
});
