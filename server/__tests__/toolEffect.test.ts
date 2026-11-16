// Every registered tool must say whether a call changes anything ("change") or
// is safe to repeat ("none"), so crash recovery knows which calls to record.
import { describe, expect, it } from "vitest";
import { effectOf } from "../toolkit";
import { toolSpecs } from "../tools";

describe("tool effect flag", () => {
  it("every registered tool has one", () => {
    const missing = toolSpecs()
      .filter((t) => !(t.effect === "none" || t.effect === "change" || typeof t.effect === "function"))
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("a function flag answers none or change for the usual arguments", () => {
    for (const t of toolSpecs()) {
      if (typeof t.effect !== "function") continue;
      for (const args of [{}, undefined, { script: "x" }]) expect(["none", "change"]).toContain(effectOf(t, args));
    }
  });

  const effect = (name: string, args: any = {}) => effectOf(toolSpecs().find((t) => t.name === name)!, args);

  it("every command is a change, whatever it claims", () => {
    expect(effect("run_command", { command: "ls", read_only: true })).toBe("change");
    expect(effect("run_command", {})).toBe("change");
  });

  it("inspect_page changes only with a script", () => {
    expect(effect("inspect_page", { url: "http://localhost" })).toBe("none");
    expect(effect("inspect_page", { url: "http://localhost", script: "   " })).toBe("none");
    expect(effect("inspect_page", { url: "http://localhost", script: "document.title" })).toBe("change");
  });

  it("writes, rules, todos, plan and worktrees are changes; reads are not", () => {
    for (const n of ["write_file", "edit_file", "add_rule", "add_todo", "complete_todo", "update_plan", "create_worktree", "remove_worktree"]) {
      expect(effect(n), n).toBe("change");
    }
    for (const n of ["read_file", "list_directory", "find_files", "grep", "locate_path", "web_search", "fetch_url", "list_todos", "read_thread", "load_skill"]) {
      expect(effect(n), n).toBe("none");
    }
  });

  it("an effect function that throws counts as a change", () => {
    expect(effectOf({ effect: () => { throw new Error("x"); } }, {})).toBe("change");
  });
});
