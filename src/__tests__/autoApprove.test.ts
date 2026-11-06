import { describe, expect, it } from "vitest";
import { autoApproves, withAuto } from "../autoApprove";

const command = (c: string) => ({ type: "command" as const, command: c, cwd: "/w" });
const change = { type: "change" as const, path: "/w/a.ts", action: "edit" as const, diff: "" };
const worktree = { type: "worktree" as const, action: "remove" as const, repo: "/r", branch: "llama/x", path: "/w/x" };

describe("autoApproves", () => {
  it("asks about everything with nothing approved", () => {
    for (const a of [change, command("git status"), worktree]) expect(autoApproves(undefined, a)).toBe(false);
    expect(autoApproves({}, change)).toBe(false);
  });

  it("approves each kind only for itself", () => {
    expect(autoApproves({ changes: true }, change)).toBe(true);
    expect(autoApproves({ changes: true }, command("git status"))).toBe(false);
    expect(autoApproves({ commands: true }, command("npm test"))).toBe(true);
    expect(autoApproves({ commands: true }, command("git status"))).toBe(true);
    expect(autoApproves({ commands: true }, command("git push"))).toBe(true);
    expect(autoApproves({ commands: true }, change)).toBe(false);
  });

  it("never approves removing a worktree", () => {
    expect(autoApproves({ changes: true, commands: true }, worktree)).toBe(false);
  });
});

describe("withAuto", () => {
  it("sets and clears a kind without touching the others or the input", () => {
    const start = { commands: true };
    const on = withAuto(start, "changes", true);
    expect(on).toEqual({ commands: true, changes: true });
    expect(start).toEqual({ commands: true });
    expect(withAuto(on, "commands", false)).toEqual({ changes: true });
    expect(withAuto(undefined, "commands", false)).toEqual({});
  });
});
