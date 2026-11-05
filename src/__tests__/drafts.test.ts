import { describe, expect, it } from "vitest";
import { withDraft } from "../drafts";

describe("withDraft", () => {
  it("keeps a draft per chat, and an emptied one is removed", () => {
    let d = withDraft({}, "a", "hello");
    d = withDraft(d, "b", "world");
    expect(d).toEqual({ a: "hello", b: "world" });
    expect(withDraft(d, "a", "")).toEqual({ b: "world" });
  });

  it("drops the oldest drafts beyond the limit, and an edited one counts as newest", () => {
    let d = withDraft({}, "a", "1", 2);
    d = withDraft(d, "b", "2", 2);
    d = withDraft(d, "a", "1 edited", 2);
    d = withDraft(d, "c", "3", 2);
    expect(Object.keys(d)).toEqual(["a", "c"]);
  });
});
