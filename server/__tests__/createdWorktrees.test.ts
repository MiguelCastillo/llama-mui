import { describe, expect, it } from "vitest";
import { createdWorktrees } from "../createdWorktrees.ts";

const call = (id: string, name = "create_worktree") => ({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: "{}" }] });
const result = (id: string, content: string) => ({ role: "tool", toolCallId: id, content });
const ok = (name: string, repo = "/Users/m/Projects/app") =>
  `Created a worktree of ${repo} at /h/.llama-mui/sessions/s1/worktrees/${name} on a new branch llama/${name}, from HEAD. It holds only the files git tracks.`;

describe("createdWorktrees", () => {
  it("reads a success", () => {
    expect(createdWorktrees([call("a"), result("a", ok("ui"))])).toEqual([
      { name: "ui", path: "/h/.llama-mui/sessions/s1/worktrees/ui", branch: "llama/ui", repo: "/Users/m/Projects/app" },
    ]);
  });
  it("ignores an error result", () => {
    expect(createdWorktrees([call("a"), result("a", "/x/ui already exists; pick another name")])).toEqual([]);
  });
  it("finds two worktrees, across steps", () => {
    const got = createdWorktrees([call("a"), result("a", ok("one")), { role: "user", content: "next" }, call("b"), result("b", ok("two"))]);
    expect(got.map((w) => w.name)).toEqual(["one", "two"]);
  });
  it("is empty without a call, or when the result is for another tool", () => {
    expect(createdWorktrees([{ role: "user", content: "hi" }])).toEqual([]);
    expect(createdWorktrees([call("a", "run_command"), result("a", ok("ui"))])).toEqual([]);
    expect(createdWorktrees(undefined)).toEqual([]);
  });
  it("ignores a call with no result yet", () => {
    expect(createdWorktrees([call("a")])).toEqual([]);
  });
  it("keeps spaces in paths and lists a repeated path once", () => {
    const text = "Created a worktree of /My Repo at /h/s/worktrees/ui on a new branch llama/ui, from HEAD.";
    const got = createdWorktrees([call("a"), result("a", text), call("b"), result("b", text)]);
    expect(got).toHaveLength(1);
    expect(got[0].repo).toBe("/My Repo");
  });
});
