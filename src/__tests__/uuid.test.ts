import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("makes a UUID v4", () => {
    expect(newId()).toMatch(V4);
  });

  it("still does where crypto.randomUUID is missing, as on a phone over plain http", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: <T extends ArrayBufferView<ArrayBuffer>>(a: T) => real.getRandomValues(a) });
    const ids = new Set(Array.from({ length: 50 }, newId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(V4);
  });
});
