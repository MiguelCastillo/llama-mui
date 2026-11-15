import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAppEvents, resetAppEvents } from "../appEvents";

class FakeSource {
  static all: FakeSource[] = [];
  closed = false;
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeSource.all = [];
  vi.stubGlobal("EventSource", FakeSource);
});
afterEach(() => {
  resetAppEvents();
  vi.unstubAllGlobals();
});

describe("the page's one event stream", () => {
  it("opens one connection however many listeners there are", () => {
    const a = openAppEvents()!;
    const b = openAppEvents()!;
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0].url).toBe("/api/events");
    expect(a.source).toBe(b.source);
  });

  it("closes it only when the last listener lets go, and a second release changes nothing", () => {
    const a = openAppEvents()!;
    const b = openAppEvents()!;
    a.release();
    a.release();
    expect(FakeSource.all[0].closed).toBe(false);
    b.release();
    expect(FakeSource.all[0].closed).toBe(true);
  });

  it("opens a fresh one after it was closed", () => {
    openAppEvents()!.release();
    openAppEvents();
    expect(FakeSource.all).toHaveLength(2);
    expect(FakeSource.all[1].closed).toBe(false);
  });

  it("does nothing where there is no EventSource", () => {
    vi.stubGlobal("EventSource", undefined);
    expect(openAppEvents()).toBeNull();
  });
});
