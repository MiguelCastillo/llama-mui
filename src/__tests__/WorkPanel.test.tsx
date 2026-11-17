import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkEntry } from "../api";
import WorkPanel, { workState } from "../WorkPanel";

const entry = (over: Partial<WorkEntry>): WorkEntry => ({
  kind: "worktree",
  name: "w",
  branch: "llama/w",
  folder: "/tmp/w",
  uncommitted: 0,
  unmerged: 1,
  files: ["a.ts", "b.ts"],
  filesTotal: 2,
  lastCommitSubject: "Do it",
  // Unix seconds, as git reports them.
  lastCommitTime: Math.floor(Date.now() / 1000) - 3 * 3600,
  merged: false,
  purpose: "Make the thing",
  source: "abc123",
  ...over,
});

const render = (entries: WorkEntry[], props: { open?: boolean; narrow?: boolean } = {}) =>
  renderToStaticMarkup(<WorkPanel entries={entries} open={props.open ?? true} narrow={props.narrow ?? false} onClose={() => {}} />);

describe("WorkPanel", () => {
  it("says nothing is in progress when empty", () => {
    expect(render([])).toContain("Nothing is in progress.");
  });

  it("shows a thread branch with purpose, state, size, age and an Open chat link", () => {
    const html = render([entry({})]);
    expect(html).toContain("Thread branches (1)");
    expect(html).toContain("Make the thing");
    expect(html).toContain("Finished and committed");
    expect(html).toContain("2 files");
    expect(html).toContain("3h ago");
    expect(html).toContain("a.ts, b.ts");
    expect(html).toContain('href="#/session/abc123"');
    expect(html).toContain("Open chat");
  });

  it("shows an older branch with no description and no chat link", () => {
    const html = render([entry({ kind: "worktree" }), entry({ kind: "branch", name: "old", branch: "old", purpose: null, source: null, filesTotal: 1, files: ["x.ts"] })]);
    expect(html).toContain("Older branches (1)");
    expect(html).toContain("No description");
    expect(html).toContain("Needs a decision");
    expect(html).toContain("1 file ·");
    expect(html.match(/Open chat/g)?.length).toBe(1);
  });

  it("shows loose files in the main folder", () => {
    const html = render([entry({ kind: "loose", name: "main", branch: null, uncommitted: 3, unmerged: null, purpose: null, source: null, lastCommitTime: null, files: [], filesTotal: 3 })]);
    expect(html).toContain("Loose files (1)");
    expect(html).toContain("In the main folder");
    expect(html).toContain("Has uncommitted files");
    expect(html).toContain("3 files");
    expect(html).not.toContain("Open chat");
  });

  it("caps the file names and says how many more", () => {
    const files = ["1", "2", "3", "4", "5", "6", "7"];
    expect(render([entry({ files, filesTotal: 9 })])).toContain("and 4 more");
  });

  it("has no buttons that change anything", () => {
    expect(render([entry({})])).not.toContain("<button");
  });

  it("draws nothing when docked and closed, and a drawer when narrow", () => {
    expect(render([entry({})], { open: false })).toBe("");
    expect(render([entry({})], { narrow: true, open: false })).not.toContain("Work in progress");
  });

  it("names states in plain words", () => {
    expect(workState(entry({ merged: true }))).toBe("Merged");
    expect(workState(entry({ uncommitted: 2 }))).toBe("Has uncommitted files");
    expect(workState(entry({ kind: "branch" }))).toBe("Needs a decision");
  });
});
