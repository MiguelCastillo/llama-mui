import { describe, expect, it } from "vitest";
import type { Attachment, SessionSummary } from "../api";
import {
  buildSessionTree,
  countNested,
  deleteLockedIds,
  descendantIds,
  filterTree,
  groupNames,
  groupTree,
  nestedHeldBy,
  nestedSessionFrom,
} from "../sessionTree";

const row = (id: string, parentId?: string | null, updatedAt = 1): SessionSummary => ({
  id,
  title: id,
  updatedAt,
  parentId,
});

// The tree as ids, so a test reads as the shape it expects.
const shape = (summaries: SessionSummary[]) =>
  buildSessionTree(summaries).map((n) => [n.session.id, n.children.map((c) => c.session.id)]);

describe("buildSessionTree", () => {
  it("keeps sessions without parents at the top level", () => {
    expect(buildSessionTree([])).toEqual([]);
    expect(shape([row("a", null, 2), row("b", undefined, 1)])).toEqual([
      ["a", []],
      ["b", []],
    ]);
  });

  it("puts a child under its parent", () => {
    expect(shape([row("p", null, 5), row("c", "p", 1)])).toEqual([["p", ["c"]]]);
  });

  it("shows a grandchild under the top parent and keeps its stored parent", () => {
    const tree = buildSessionTree([row("p", null, 3), row("c", "p", 2), row("g", "c", 1)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((n) => n.session.id)).toEqual(["c", "g"]);
    expect(tree[0].children.every((n) => n.children.length === 0)).toBe(true);
    expect(tree[0].children[1].session.parentId).toBe("c");
  });

  it("shows a session whose parent is missing at the top level, with its own children", () => {
    expect(shape([row("o", "gone", 2), row("c", "o", 1)])).toEqual([["o", ["c"]]]);
  });

  it("shows both sessions of a two-session cycle at the top level without looping", () => {
    expect(shape([row("a", "b", 2), row("b", "a", 1)])).toEqual([
      ["a", []],
      ["b", []],
    ]);
  });

  it("shows a session that is its own parent at the top level", () => {
    expect(shape([row("a", "a")])).toEqual([["a", []]]);
  });

  it("shows a child of a cycle member under that member", () => {
    expect(shape([row("a", "b", 3), row("b", "a", 2), row("c", "b", 1)])).toEqual([
      ["a", []],
      ["b", ["c"]],
    ]);
  });

  it("shows a child of a self-parent under it", () => {
    expect(shape([row("a", "a", 2), row("c", "a", 1)])).toEqual([["a", ["c"]]]);
  });

  it("sorts newest first at the top level and among siblings, then by id", () => {
    const tree = buildSessionTree([
      row("old", null, 1),
      row("new", null, 9),
      row("p", null, 5),
      row("c1", "p", 2),
      row("c3", "p", 8),
      row("c2", "p", 2),
    ]);
    expect(tree.map((n) => n.session.id)).toEqual(["new", "p", "old"]);
    expect(tree[1].children.map((n) => n.session.id)).toEqual(["c3", "c1", "c2"]);
  });
});

describe("countNested", () => {
  it("counts the children", () => {
    const [none] = buildSessionTree([row("a")]);
    expect(countNested(none)).toBe(0);
    const [p] = buildSessionTree([row("p"), row("c1", "p"), row("c2", "p"), row("g", "c1")]);
    expect(countNested(p)).toBe(3);
  });
});

describe("descendantIds", () => {
  const rows = [row("p"), row("c1", "p"), row("c2", "p"), row("g", "c1"), row("gg", "g"), row("x"), row("y", "x")];
  it("lists everything nested under a session, at any depth, parents before their children", () => {
    expect(descendantIds(rows, "p")).toEqual(["c1", "c2", "g", "gg"]);
    expect(descendantIds(rows, "c1")).toEqual(["g", "gg"]);
  });
  it("is empty for a session with none or an unknown id, and leaves other families out", () => {
    expect(descendantIds(rows, "gg")).toEqual([]);
    expect(descendantIds(rows, "nope")).toEqual([]);
    expect(descendantIds(rows, "x")).toEqual(["y"]);
  });
  it("stops on a parentId cycle and never lists the session itself", () => {
    expect(descendantIds([row("a", "b"), row("b", "a")], "a")).toEqual(["b"]);
    expect(descendantIds([row("s", "s")], "s")).toEqual([]);
  });
});

describe("deleteLockedIds", () => {
  // Two families, p (with a child and a grandchild shown under it) and x (alone).
  const tree = buildSessionTree([row("p"), row("c", "p"), row("g", "c"), row("x"), row("y")]);
  const locked = (...running: string[]) => [...deleteLockedIds(tree, new Set(running))].sort();

  it("locks nothing while no run is in progress", () => {
    expect(locked()).toEqual([]);
  });
  it("locks the whole family when its top-level session runs", () => {
    expect(locked("p")).toEqual(["c", "g", "p"]);
  });
  it("locks the whole family, parent included, when a nested session runs", () => {
    expect(locked("c")).toEqual(["c", "g", "p"]);
    expect(locked("g")).toEqual(["c", "g", "p"]);
  });
  it("leaves other families alone", () => {
    expect(locked("x")).toEqual(["x"]);
    expect(locked("p", "x")).toEqual(["c", "g", "p", "x"]);
  });
  it("ignores an id that is not listed", () => {
    expect(locked("nope")).toEqual([]);
  });
});

describe("nestedHeldBy", () => {
  const rows = [row("p"), row("c", "p"), row("g", "c"), row("x")];
  it("counts everything shown under a top-level session", () => {
    expect(nestedHeldBy(rows, "p")).toBe(2);
  });
  it("counts the direct children of a nested session, which the tree shows under the top row", () => {
    expect(nestedHeldBy(rows, "c")).toBe(1);
  });
  it("is 0 for a session with none, an unknown id, or a self-parent", () => {
    expect(nestedHeldBy(rows, "x")).toBe(0);
    expect(nestedHeldBy(rows, "nope")).toBe(0);
    expect(nestedHeldBy([row("s", "s")], "s")).toBe(0);
  });
});

describe("nestedSessionFrom", () => {
  const attachments: Attachment[] = [{ path: "/work/app", kind: "folder", source: "manual" }];
  const parent = { id: "p", model: "some-model", attachments };

  it("starts from the parent's model and attachments and is nested under it", () => {
    const s = nestedSessionFrom(parent, "child");
    expect(s).toMatchObject({
      id: "child",
      title: "New session",
      model: "some-model",
      parentId: "p",
      attachments: [{ path: "/work/app", kind: "folder", source: "manual" }],
    });
  });

  it("starts on the parent's connection, and has none when the parent has none", () => {
    expect(nestedSessionFrom({ ...parent, connectorId: "c-1" }, "child").connectorId).toBe("c-1");
    expect("connectorId" in nestedSessionFrom(parent, "child")).toBe(false);
  });

  it("does not share the attachments array with the parent", () => {
    const s = nestedSessionFrom(parent, "child");
    expect(s.attachments).not.toBe(attachments);
    expect(s.attachments[0]).not.toBe(attachments[0]);
    s.attachments.push({ path: "/other", kind: "folder", source: "manual" });
    expect(attachments).toHaveLength(1);
  });

  it("does not take the parent's messages, plan or todos", () => {
    const s = nestedSessionFrom(parent, "child");
    expect(s.messages).toEqual([]);
    expect(s.plan).toBeNull();
    expect(s.todos).toEqual([]);
    expect(s.usage).toBeNull();
  });
});

describe("filterTree", () => {
  const rows = [row("alpha", null, 4), row("a-kid", "alpha", 3), row("beta", null, 2), row("b-hit", "beta", 1)];
  const ids = (tree: ReturnType<typeof filterTree>) => tree.map((n) => [n.session.id, n.children.map((c) => c.session.id)]);
  const has = (word: string) => (s: SessionSummary) => s.id.includes(word);

  it("keeps everything when every session matches", () => {
    expect(ids(filterTree(buildSessionTree(rows), () => true))).toEqual(ids(buildSessionTree(rows)));
  });

  it("a matching parent keeps all of its nested sessions", () => {
    expect(ids(filterTree(buildSessionTree(rows), has("alpha")))).toEqual([["alpha", ["a-kid"]]]);
  });

  it("a matching nested session keeps its parent, with only the matches under it", () => {
    expect(ids(filterTree(buildSessionTree(rows), has("hit")))).toEqual([["beta", ["b-hit"]]]);
  });

  it("drops what doesn't match", () => {
    expect(filterTree(buildSessionTree(rows), has("zzz"))).toEqual([]);
  });
});

describe("groupTree", () => {
  const g = (id: string, group: string | null, updatedAt = 1): SessionSummary => ({ ...row(id, null, updatedAt), group });

  it("lists groups A to Z first, then ungrouped sessions, newest first inside", () => {
    const groups = groupTree(buildSessionTree([g("a", "Work", 1), g("b", null, 2), g("c", "Home", 3), g("d", "Work", 4)]));
    expect(groups.map((x) => [x.name, x.nodes.map((n) => n.session.id)])).toEqual([
      ["Home", ["c"]],
      ["Work", ["d", "a"]],
      [null, ["b"]],
    ]);
  });

  it("has no ungrouped section when every session is in a group", () => {
    expect(groupTree(buildSessionTree([g("a", "Work")])).map((x) => x.name)).toEqual(["Work"]);
  });

  it("a nested session goes with its parent, whatever its own group says", () => {
    const rows = [g("p", "Work", 2), { ...row("c", "p", 1), group: "Home" }];
    expect(groupTree(buildSessionTree(rows)).map((x) => [x.name, x.nodes[0].children.length])).toEqual([["Work", 1]]);
  });
});

describe("groupNames", () => {
  it("lists the groups in use once each, A to Z, ignoring nested sessions", () => {
    const rows: SessionSummary[] = [
      { ...row("a"), group: "Work" },
      { ...row("b"), group: "Home" },
      { ...row("c"), group: "Work" },
      { ...row("d", "a"), group: "Zed" },
      row("e"),
    ];
    expect(groupNames(rows)).toEqual(["Home", "Work"]);
  });
});
