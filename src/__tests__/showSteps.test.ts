import { afterEach, describe, expect, it, vi } from "vitest";
import { readShowSteps, setShowSteps } from "../showSteps";

const store = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("showSteps", () => {
  it("is off until turned on", () => {
    vi.stubGlobal("localStorage", store());
    expect(readShowSteps()).toBe(false);
  });

  it("keeps the choice in this browser", () => {
    vi.stubGlobal("localStorage", store());
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    setShowSteps(true);
    expect(readShowSteps()).toBe(true);
    setShowSteps(false);
    expect(readShowSteps()).toBe(false);
  });

  it("is off when storage can't be read", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
    });
    expect(readShowSteps()).toBe(false);
  });
});
