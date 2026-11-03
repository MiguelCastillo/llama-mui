import { describe, expect, it } from "vitest";
import { CREATURES, STARTERS, oldTodos, pickCreature, pickSuggestions } from "../suggestions";

const step = (text: string, status: any = "pending") => ({ id: text, text, status });

describe("oldTodos", () => {
  it("takes unfinished steps with the session title and a Continue prefix", () => {
    expect(oldTodos([{ title: "Fix build", plan: [step("a", "done"), step("b"), step("c", "failed")] }])).toEqual([
      { text: "Continue: b", from: "Fix build" },
      { text: "Continue: c", from: "Fix build" },
    ]);
  });

  it("skips fully done, empty and missing plans, and blank steps", () => {
    expect(
      oldTodos([
        { title: "x", plan: [step("a", "done")] },
        { title: "y", plan: [] },
        { title: "z", plan: null },
        { title: "w", plan: undefined },
        { title: "v", plan: [step("  "), step("d")] },
      ]),
    ).toEqual([{ text: "Continue: d", from: "v" }]);
  });
});

describe("pickSuggestions", () => {
  const todos = [1, 2, 3].map((n) => ({ text: `Continue: t${n}`, from: "s" }));

  it("shows three starters when there are no todos", () => {
    const got = pickSuggestions([], () => 0.3);
    expect(got).toHaveLength(3);
    expect(got.every((s) => !s.from && STARTERS.includes(s.text))).toBe(true);
  });

  it("mixes at most two todos with starters", () => {
    const got = pickSuggestions(todos, () => 0.5);
    expect(got).toHaveLength(3);
    expect(got.filter((s) => s.from)).toHaveLength(2);
  });

  it("fills up when there is one todo, and never repeats", () => {
    const got = pickSuggestions(todos.slice(0, 1), () => 0.9);
    expect(got.filter((s) => s.from)).toHaveLength(1);
    expect(new Set(got.map((s) => s.text)).size).toBe(3);
  });

  it("depends on the random source", () => {
    const seq = (vals: number[]) => {
      let i = 0;
      return () => vals[i++ % vals.length];
    };
    const a = pickSuggestions([], seq([0.1, 0.2, 0.3]));
    const b = pickSuggestions([], seq([0.9, 0.8, 0.7]));
    expect(a).not.toEqual(b);
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
