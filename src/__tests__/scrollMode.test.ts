import { afterEach, describe, expect, it, vi } from "vitest";
import { pinsOnSend, readScrollMode, setScrollMode } from "../scrollMode";

const store = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set("llama-mui:scroll-mode", initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("scrollMode", () => {
  it("keeps the newest text in view until changed", () => {
    vi.stubGlobal("localStorage", store());
    expect(readScrollMode()).toBe("follow");
  });

  it("ignores a saved value it doesn't know", () => {
    vi.stubGlobal("localStorage", store("sideways"));
    expect(readScrollMode()).toBe("follow");
  });

  it("keeps the choice in this browser", () => {
    vi.stubGlobal("localStorage", store());
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    setScrollMode("pin");
    expect(readScrollMode()).toBe("pin");
    setScrollMode("follow");
    expect(readScrollMode()).toBe("follow");
  });

  it("pins a sent message only in pin mode, and reads the choice at each send", () => {
    vi.stubGlobal("localStorage", store());
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    expect(pinsOnSend(readScrollMode())).toBe(false);
    setScrollMode("pin");
    expect(pinsOnSend(readScrollMode())).toBe(true);
    setScrollMode("follow");
    expect(pinsOnSend(readScrollMode())).toBe(false);
  });

  it("is follow when storage can't be read", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
    });
    expect(readScrollMode()).toBe("follow");
  });
});
