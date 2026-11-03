import { describe, expect, it } from "vitest";
import { CREATURES, STARTERS, pickCreature, pickSuggestions, visibleCount } from "../suggestions";

describe("pickSuggestions", () => {
  it("gives three distinct starters by default", () => {
    const got = pickSuggestions(() => 0.3);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
    expect(got.every((t) => STARTERS.includes(t))).toBe(true);
  });

  it("gives the count asked for", () => {
    expect(pickSuggestions(() => 0.5, 1)).toHaveLength(1);
  });

  it("depends on the random source", () => {
    const seq = (vals: number[]) => {
      let i = 0;
      return () => vals[i++ % vals.length];
    };
    expect(pickSuggestions(seq([0.1, 0.2, 0.3]))).not.toEqual(pickSuggestions(seq([0.9, 0.8, 0.7])));
  });
});

describe("pickCreature", () => {
  it("follows the random source, one creature per equal slice", () => {
    expect(CREATURES.map((_, i) => pickCreature(() => (i + 0.5) / CREATURES.length))).toEqual([...CREATURES]);
  });

  it("stays in range at the ends of the random source", () => {
    expect(pickCreature(() => 0)).toBe(CREATURES[0]);
    expect(pickCreature(() => 0.999999)).toBe(CREATURES[CREATURES.length - 1]);
    expect(pickCreature(() => 1)).toBe(CREATURES[CREATURES.length - 1]);
  });
});

describe("visibleCount", () => {
  it("makes room for the My Todos button", () => {
    expect(visibleCount(false, false)).toBe(3);
    expect(visibleCount(false, true)).toBe(2);
    expect(visibleCount(true, false)).toBe(2);
    expect(visibleCount(true, true)).toBe(1);
  });
});
