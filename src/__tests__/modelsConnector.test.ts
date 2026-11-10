import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSavedModelsConnectorId,
  pickModelsConnector,
  setSavedModelsConnectorId,
} from "../modelsConnector";

const a = { id: "a", name: "A" };
const b = { id: "b", name: "B" };
const c = { id: "c", name: "C" };

describe("pickModelsConnector", () => {
  it("uses the saved connection when it still exists", () => {
    expect(pickModelsConnector([a, b, c], "a", "c")).toBe(c);
  });

  it("falls back to the active one when the saved one was deleted", () => {
    expect(pickModelsConnector([a, b], "b", "gone")).toBe(b);
  });

  it("uses the active one when nothing is saved", () => {
    expect(pickModelsConnector([a, b], "b", null)).toBe(b);
  });

  it("uses the first one when there is no active connection", () => {
    expect(pickModelsConnector([a, b], null, null)).toBe(a);
    expect(pickModelsConnector([a, b], "gone", "also-gone")).toBe(a);
  });

  it("returns null for an empty list", () => {
    expect(pickModelsConnector([], "a", "a")).toBeNull();
  });
});

describe("saved connection id", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is stored and read back", () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
    expect(getSavedModelsConnectorId()).toBeNull();
    setSavedModelsConnectorId("b");
    expect(getSavedModelsConnectorId()).toBe("b");
  });

  it("doesn't throw when storage fails", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(getSavedModelsConnectorId()).toBeNull();
    expect(() => setSavedModelsConnectorId("b")).not.toThrow();
  });
});
