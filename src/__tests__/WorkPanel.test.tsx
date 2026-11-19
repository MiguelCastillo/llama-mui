// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
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

const render = (entries: WorkEntry[]) => renderToStaticMarkup(<WorkPanel entries={entries} />);

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

  it("offers Follow up on every entry that is not merged, and none on merged ones", () => {
    const f = () => {};
    const r = (entries: WorkEntry[]) => renderToStaticMarkup(<WorkPanel entries={entries} onFollowUp={f} />);
    const loose = entry({ kind: "loose", branch: null, unmerged: null, uncommitted: 2, source: null });
    const html = r([entry({}), entry({ kind: "branch", name: "old", branch: "old" }), loose]);
    expect(html.match(/>Follow up</g)?.length).toBe(3);
    expect(r([entry({ merged: true })])).not.toContain("<button");
  });

  it("draws no buttons when nothing handles Follow up", () => {
    expect(render([entry({})])).not.toContain("<button");
  });

  it("has no Merge text anywhere", () => {
    const f = () => {};
    const html = renderToStaticMarkup(<WorkPanel entries={[entry({}), entry({ kind: "branch", name: "old", branch: "old" })]} onFollowUp={f} />);
    expect(html).not.toMatch(/>(Merge|Approve|Discard)</);
  });

  it("calls onFollowUp with the entry when Follow up is clicked", () => {
    const e = entry({});
    const calls: WorkEntry[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.render(<WorkPanel entries={[e]} onFollowUp={(x) => calls.push(x)} />));
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Follow up");
    expect(button).toBeTruthy();
    act(() => button!.click());
    expect(calls).toEqual([e]);
    act(() => root.unmount());
    host.remove();
  });

  it("shows the state as a chip with a color for each state", () => {
    const chip = (e: WorkEntry) => render([e]).match(/<div class="MuiChip-root[^"]*"/)?.[0] ?? "";
    expect(chip(entry({}))).toContain("MuiChip-colorSuccess");
    expect(chip(entry({ kind: "branch" }))).toContain("MuiChip-colorWarning");
    expect(chip(entry({ kind: "branch" }))).toContain("MuiChip-filled");
    expect(chip(entry({ uncommitted: 2 }))).toContain("MuiChip-outlined");
    expect(chip(entry({ merged: true }))).toContain("MuiChip-colorDefault");
  });

  it("puts entries needing attention first and merged ones last", () => {
    const html = render([
      entry({ purpose: "Merged one", merged: true }),
      entry({ purpose: "Finished one" }),
      entry({ purpose: "Dirty one", uncommitted: 2 }),
    ]);
    const at = (s: string) => html.indexOf(s);
    expect(at("Dirty one")).toBeLessThan(at("Finished one"));
    expect(at("Finished one")).toBeLessThan(at("Merged one"));
  });

  it("dims merged entries only", () => {
    const opacityOf = (e: WorkEntry) => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      act(() => root.render(<WorkPanel entries={[e]} />));
      const card = host.querySelector("[data-work-entry]")!.parentElement!;
      const value = getComputedStyle(card).opacity;
      act(() => root.unmount());
      host.remove();
      return value;
    };
    expect(opacityOf(entry({ merged: true }))).toBe("0.6");
    expect(opacityOf(entry({}))).toBe("1");
  });

  it("hides counts that contradict a merged state", () => {
    const html = render([entry({ merged: true, uncommitted: 11, filesTotal: 0, files: [] })]);
    expect(html).toContain("Merged");
    expect(html).not.toContain("uncommitted");
    expect(html).not.toContain("No files changed");
  });

  it("shows Open chat and Follow up together in one row", () => {
    const f = () => {};
    const html = renderToStaticMarkup(<WorkPanel entries={[entry({})]} onFollowUp={f} />);
    const open = html.indexOf("Open chat");
    const follow = html.indexOf(">Follow up<");
    expect(open).toBeGreaterThan(-1);
    expect(follow).toBeGreaterThan(open);
    // Nothing but the two buttons sits between them.
    expect(html.slice(open, follow)).not.toMatch(/<(p|span class="MuiTypography)/);
  });

  it("names states in plain words", () => {
    expect(workState(entry({ merged: true }))).toBe("Merged");
    expect(workState(entry({ uncommitted: 2 }))).toBe("Has uncommitted files");
    expect(workState(entry({ kind: "branch" }))).toBe("Needs a decision");
  });
});
