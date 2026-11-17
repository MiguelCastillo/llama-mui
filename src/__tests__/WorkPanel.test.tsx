import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MergeAttemptState, WorkEntry } from "../api";
import WorkPanel, { workState, type MergeUi } from "../WorkPanel";

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

  describe("merging", () => {
    const noop = () => {};
    const ui = (attempt: MergeAttemptState | null, error: string | null = null): MergeUi => ({
      attempt,
      error,
      start: noop,
      approve: noop,
      discard: noop,
      dismiss: noop,
    });
    const att = (over: Partial<MergeAttemptState>): MergeAttemptState => ({ id: "1", branch: "llama/w", state: "ready", checks: [], ...over });
    const renderM = (entries: WorkEntry[], merge: MergeUi) =>
      renderToStaticMarkup(<WorkPanel entries={entries} open narrow={false} onClose={noop} merge={merge} />);

    it("offers Merge on thread and older branches with unmerged commits and no uncommitted files", () => {
      const html = renderM([entry({}), entry({ kind: "branch", name: "old", branch: "old" })], ui(null));
      expect(html.match(/>Merge</g)?.length).toBe(2);
    });

    it("offers no Merge on loose, merged, empty or uncommitted entries", () => {
      const loose = entry({ kind: "loose", branch: null, unmerged: null, uncommitted: 2 });
      expect(renderM([loose], ui(null))).not.toContain("<button");
      expect(renderM([entry({ merged: true })], ui(null))).not.toContain("<button");
      expect(renderM([entry({ unmerged: 0 })], ui(null))).not.toContain("<button");
      expect(renderM([entry({ uncommitted: 1 })], ui(null))).not.toContain("<button");
    });

    it("shows progress while replaying and while checking", () => {
      expect(renderM([entry({})], ui(att({ state: "replaying", replayed: 2 })))).toContain("Replaying 2 commits");
      const html = renderM([entry({})], ui(att({ state: "checking", check: "tests" })));
      expect(html).toContain("Running tests");
      expect(html).not.toContain(">Merge<");
    });

    it("lists the clashing files on a conflict", () => {
      const html = renderM([entry({})], ui(att({ state: "conflict", files: ["a.ts", "z.ts"] })));
      expect(html).toContain("a.ts, z.ts");
      expect(html).toContain("nothing was merged");
    });

    it("shows passed checks with Approve and Discard", () => {
      const html = renderM([entry({})], ui(att({ checks: [{ name: "tests", ok: true, output: "", seconds: 1 }] })));
      expect(html).toContain("tests: passed");
      expect(html).toContain(">Approve<");
      expect(html).toContain(">Discard<");
    });

    it("shows the output of a failed check and no Approve", () => {
      const html = renderM([entry({})], ui(att({ state: "failed", checks: [{ name: "build", ok: false, output: "boom at line 3", seconds: 1 }] })));
      expect(html).toContain("build: failed");
      expect(html).toContain("boom at line 3");
      expect(html).not.toContain(">Approve<");
      expect(html).toContain(">Discard<");
    });

    it("says Merged after merging", () => {
      expect(renderM([entry({})], ui(att({ state: "merged" })))).toContain("Merged");
    });

    it("hides Merge on other entries while an attempt is open", () => {
      const other = entry({ name: "o", branch: "llama/o" });
      const html = renderM([entry({}), other], ui(att({ state: "checking", check: "tests" })));
      expect(html).not.toContain(">Merge<");
    });

    it("shows a start error", () => {
      expect(renderM([entry({})], ui(null, "Already in progress"))).toContain("Already in progress");
    });
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
