import { describe, expect, it } from "vitest";
import { applyPatch, copyForEvents, diffSession } from "../sessionPatch.ts";

const msg = (role: string, content: string) => ({ role, content });

describe("diffSession", () => {
  it("is null when nothing changed", () => {
    const s = { id: "a", title: "T", messages: [msg("user", "hi")] };
    expect(diffSession(s, copyForEvents(s))).toBeNull();
  });

  it("sends only the end of the chat when a reply grows", () => {
    const before = { id: "a", messages: [msg("user", "hi"), msg("assistant", "Hel")] };
    const after = { id: "a", messages: [msg("user", "hi"), msg("assistant", "Hello"), msg("user", "more")] };
    const patch = diffSession(before, after)!;
    expect(patch.fields).toEqual({});
    expect(patch.messages).toEqual({ from: 1, items: [msg("assistant", "Hello"), msg("user", "more")], length: 3 });
    expect(JSON.stringify(patch)).not.toContain('"hi"'); // the unchanged message isn't sent
  });

  it("sends changed fields in full and names removed ones", () => {
    const before = { id: "a", title: "Old", failed: "boom", plan: [{ id: "s1", status: "running" }], messages: [] };
    const after = { id: "a", title: "Old", plan: [{ id: "s1", status: "done" }], messages: [] };
    expect(diffSession(before, after)).toEqual({
      fields: { plan: [{ id: "s1", status: "done" }] },
      removed: ["failed"],
    });
  });

  it("cuts the old tail off when the chat got shorter", () => {
    const before = { messages: [msg("user", "a"), msg("assistant", "b"), msg("user", "c")] };
    const after = { messages: [msg("user", "a")] };
    const patch = diffSession(before, after)!;
    expect(patch.messages).toEqual({ from: 1, items: [], length: 1 });
    expect(applyPatch(before, patch)).toEqual(after);
  });

  it("leaves the server's revision and run out of it", () => {
    const before = { id: "a", revision: 1, run: { status: "running" }, messages: [] };
    const after = { id: "a", revision: 2, messages: [] };
    expect(diffSession(before, after)).toBeNull();
    expect(copyForEvents(before)).toEqual({ id: "a", messages: [] });
  });

  it("gives the later copy back when applied to the earlier one", () => {
    const before = { id: "a", title: "x", note: "n", messages: [msg("user", "1"), msg("assistant", "2")] };
    const after = { id: "a", title: "y", messages: [msg("user", "1"), msg("assistant", "22"), msg("user", "3")] };
    expect(applyPatch(before, diffSession(before, after)!)).toEqual(after);
  });
});
