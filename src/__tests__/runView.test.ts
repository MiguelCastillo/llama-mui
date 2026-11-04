import { describe, expect, it } from "vitest";
import { type RunnerView, isLive } from "../runView";

const view = (status: RunnerView["status"]) => ({ status }) as RunnerView;

describe("isLive", () => {
  it("is true from the start of a run until it ends, paused and waiting included", () => {
    for (const s of ["running", "pausing", "paused", "waiting"] as const) expect(isLive(view(s))).toBe(true);
  });
  it("is false once it has stopped, or when there is no run", () => {
    expect(isLive(view("stopped"))).toBe(false);
    expect(isLive(undefined)).toBe(false);
    expect(isLive(null)).toBe(false);
  });
});
