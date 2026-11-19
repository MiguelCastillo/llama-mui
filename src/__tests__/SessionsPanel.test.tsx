import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionSummary, WorkEntry } from "../api";
import SessionsPanel from "../SessionsPanel";

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  title: "A chat",
  updatedAt: Date.now(),
  ...over,
});

const entry = (over: Partial<WorkEntry> = {}): WorkEntry => ({
  kind: "worktree",
  name: "w",
  branch: "llama/w",
  folder: "/tmp/w",
  uncommitted: 0,
  unmerged: 1,
  files: ["a.ts"],
  filesTotal: 1,
  lastCommitSubject: "Do it",
  lastCommitTime: Math.floor(Date.now() / 1000) - 3 * 3600,
  merged: false,
  purpose: "Make the thing",
  source: "abc123",
  ...over,
});

const noop = () => {};

const render = (over: { workEntries?: WorkEntry[] } = {}) =>
  renderToStaticMarkup(
    <SessionsPanel
      sessions={[session()]}
      currentId="s1"
      open
      narrow={false}
      busy={false}
      attention={new Set()}
      inProgress={new Set()}
      onSelect={noop}
      onNew={noop}
      onNewNested={noop}
      onDelete={noop}
      onRename={noop}
      onGroup={noop}
      onClose={noop}
      workEntries={over.workEntries}
    />,
  );

describe("SessionsPanel", () => {
  it("shows the work-in-progress section with its count and entries, open by default", () => {
    const html = render({ workEntries: [entry({})] });
    // The header band: the title, then the count of entries as a caption.
    expect(html).toMatch(/Work in progress[\s\S]*?MuiTypography-caption[^>]*>1<\/span>/);
    // The section body renders the entry.
    expect(html).toContain("Make the thing");
    expect(html).toContain("Thread branches (1)");
    expect(html).toContain('href="#/session/abc123"');
    expect(html).not.toContain(">Merge<");
  });

  it("shows the work-in-progress section with no entries", () => {
    const html = render({ workEntries: [] });
    expect(html).toMatch(/Work in progress[\s\S]*?MuiTypography-caption[^>]*>0<\/span>/);
    expect(html).toContain("Nothing is in progress.");
  });
});
