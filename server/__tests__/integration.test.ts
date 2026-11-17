import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { audit } from "../audit.ts";
import { approveMerge, defaultMergeChecks, discardMerge, prepareMerge, runChecks } from "../integration.ts";

vi.mock("../audit.ts", () => ({ audit: vi.fn() }));

process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function makeRepo() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "integ-")));
  const repo = path.join(root, "repo");
  git(root, "init", "-b", "main", repo);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "first");
  return { root, repo, integrationRoot: path.join(root, "integration") };
}

function commitOn(repo: string, file: string, text: string, msg: string) {
  writeFileSync(path.join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", msg);
}

describe("prepareMerge", () => {
  it("replays the branch commits one by one on main's tip with new ids and straight history", async () => {
    const { repo, integrationRoot } = makeRepo();
    git(repo, "checkout", "-b", "feat");
    commitOn(repo, "b.txt", "b\n", "add b");
    commitOn(repo, "c.txt", "c\n", "add c");
    git(repo, "checkout", "main");
    commitOn(repo, "m.txt", "m\n", "main moves");
    const tip = git(repo, "rev-parse", "main");
    const featCommits = git(repo, "rev-list", "main..feat").split("\n");
    writeFileSync(path.join(repo, "dirty.txt"), "mine\n");

    const r = await prepareMerge(repo, "feat", { integrationRoot });
    if (r.conflict) throw new Error("unexpected conflict");
    expect(r).toMatchObject({ base: "main", baseTip: tip, integrationBranch: "llama/integration/feat", replayed: 2 });
    expect(r.folder.startsWith(integrationRoot)).toBe(true);
    expect(path.relative(integrationRoot, r.folder)).toMatch(/^repo-[0-9a-f]{8}\/feat$/);

    const replayed = git(r.folder, "rev-list", "--reverse", `${tip}..HEAD`).split("\n");
    expect(replayed).toHaveLength(2);
    for (const id of replayed) expect(featCommits).not.toContain(id);
    expect(git(r.folder, "log", "--reverse", "--format=%s", `${tip}..HEAD`)).toBe("add b\nadd c");
    expect(git(r.folder, "rev-list", "--merges", "--count", `${tip}..HEAD`)).toBe("0");
    expect(git(r.folder, "rev-parse", "HEAD~2")).toBe(tip);
    expect(readFileSync(path.join(r.folder, "m.txt"), "utf8")).toBe("m\n");

    // main folder untouched: same branch, same tip, uncommitted file still there
    expect(git(repo, "rev-parse", "main")).toBe(tip);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(readFileSync(path.join(repo, "dirty.txt"), "utf8")).toBe("mine\n");
    expect(git(repo, "status", "--porcelain")).toBe("?? dirty.txt");
  });

  it("skips changes already on main and refuses when nothing is left", async () => {
    const { repo, integrationRoot } = makeRepo();
    git(repo, "checkout", "-b", "feat");
    commitOn(repo, "b.txt", "b\n", "add b");
    git(repo, "checkout", "main");
    git(repo, "cherry-pick", "feat");
    await expect(prepareMerge(repo, "feat", { integrationRoot })).rejects.toThrow(/already on the main branch/);
    await expect(prepareMerge(repo, "main", { integrationRoot })).rejects.toThrow(/main branch itself/);
    await expect(prepareMerge(repo, "nope", { integrationRoot })).rejects.toThrow(/no branch/);
  });

  it("on a conflict leaves nothing behind and lists the clashing files", async () => {
    const { repo, integrationRoot } = makeRepo();
    git(repo, "checkout", "-b", "feat");
    commitOn(repo, "ok.txt", "ok\n", "fine one");
    commitOn(repo, "a.txt", "feature\n", "edit a");
    git(repo, "checkout", "main");
    commitOn(repo, "a.txt", "main\n", "edit a on main");
    const tip = git(repo, "rev-parse", "main");
    const branchesBefore = git(repo, "branch", "--format=%(refname:short)");

    const r = await prepareMerge(repo, "feat", { integrationRoot });
    expect(r).toEqual({ conflict: true, files: ["a.txt"] });

    expect(git(repo, "branch", "--format=%(refname:short)")).toBe(branchesBefore);
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    const left = existsSync(integrationRoot) ? readdirSync(integrationRoot).flatMap((d) => readdirSync(path.join(integrationRoot, d))) : [];
    expect(left).toEqual([]);
    expect(git(repo, "rev-parse", "main")).toBe(tip);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("main\n");
  });
});

describe("approveMerge and discardMerge", () => {
  const pass = [{ name: "test", ok: true, output: "", seconds: 0 }];
  const fail = [{ name: "test", ok: false, output: "boom", seconds: 0 }];

  async function prepared(extra?: (repo: string) => void) {
    const { repo, integrationRoot } = makeRepo();
    git(repo, "checkout", "-b", "feat");
    commitOn(repo, "b.txt", "b\n", "add b");
    commitOn(repo, "a.txt", "feature\n", "edit a");
    git(repo, "checkout", "main");
    extra?.(repo);
    const r = await prepareMerge(repo, "feat", { integrationRoot });
    if (r.conflict) throw new Error("unexpected conflict");
    return { repo, r };
  }
  const branches = (repo: string) => git(repo, "branch", "--format=%(refname:short)").split("\n");

  it("fast-forwards main to the replayed commits and cleans up", async () => {
    const { repo, r } = await prepared();
    writeFileSync(path.join(repo, "mine.txt"), "mine\n");
    const res = await approveMerge(repo, { ...r, checks: pass });
    expect(res).toMatchObject({ merged: true, base: "main", commits: 2 });
    expect(git(repo, "rev-parse", "main")).toBe(git(repo, "rev-parse", res.to));
    expect(git(repo, "log", "--format=%s", `${r.baseTip}..main`)).toBe("edit a\nadd b");
    expect(git(repo, "rev-list", "--merges", "--count", `${r.baseTip}..main`)).toBe("0");
    expect(readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("b\n");
    expect(branches(repo)).not.toContain("llama/integration/feat");
    expect(existsSync(r.folder)).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("?? mine.txt");
    expect(audit).toHaveBeenCalledWith("merge.approved", expect.objectContaining({ branch: "feat", commits: 2, approvedBy: "user" }));
  });

  it("refuses when main has moved, and changes nothing", async () => {
    const { repo, r } = await prepared();
    commitOn(repo, "later.txt", "x\n", "main moves");
    const tip = git(repo, "rev-parse", "main");
    await expect(approveMerge(repo, { ...r, checks: pass })).rejects.toThrow(/has moved/);
    expect(git(repo, "rev-parse", "main")).toBe(tip);
    expect(existsSync(r.folder)).toBe(true);
  });

  it("refuses when the checks failed or did not all run", async () => {
    const { repo, r } = await prepared();
    await expect(approveMerge(repo, { ...r, checks: fail })).rejects.toThrow(/not all passed/);
    await expect(approveMerge(repo, { ...r, checks: [] })).rejects.toThrow(/not all passed/);
    await expect(approveMerge(repo, { ...r, checks: pass, expectedChecks: 2 })).rejects.toThrow(/not all passed/);
    expect(git(repo, "rev-parse", "main")).toBe(r.baseTip);
  });

  it("refuses when a touched file has uncommitted edits, leaving main and the edit alone", async () => {
    const { repo, r } = await prepared();
    writeFileSync(path.join(repo, "a.txt"), "my unsaved edit\n");
    await expect(approveMerge(repo, { ...r, checks: pass })).rejects.toThrow(/uncommitted edits/);
    expect(git(repo, "rev-parse", "main")).toBe(r.baseTip);
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("my unsaved edit\n");
    expect(existsSync(r.folder)).toBe(true);
  });

  it("discard removes only the integration folder and branch", async () => {
    const { repo, r } = await prepared();
    writeFileSync(path.join(repo, "mine.txt"), "mine\n");
    await discardMerge(repo, { ...r, checks: pass });
    expect(git(repo, "rev-parse", "main")).toBe(r.baseTip);
    expect(branches(repo).sort()).toEqual(["feat", "main"]);
    expect(existsSync(r.folder)).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("?? mine.txt");
    expect(audit).toHaveBeenCalledWith("merge.discarded", expect.objectContaining({ branch: "feat" }));
  });
});

describe("runChecks", () => {
  const folder = () => realpathSync(mkdtempSync(path.join(tmpdir(), "checks-")));

  it("runs every check in the folder, in order, when all pass", async () => {
    const dir = folder();
    const started: string[] = [];
    const r = await runChecks(dir, [
      { name: "one", command: "echo first > order.txt; pwd" },
      { name: "two", command: "echo second >> order.txt" },
    ], { onStart: (n) => started.push(n) });
    expect(r.map((c) => [c.name, c.ok])).toEqual([["one", true], ["two", true]]);
    expect(r[0].output).toBe(dir);
    expect(typeof r[0].seconds).toBe("number");
    expect(started).toEqual(["one", "two"]);
    expect(readFileSync(path.join(dir, "order.txt"), "utf8")).toBe("first\nsecond\n");
  });

  it("stops at the first failure and keeps its output", async () => {
    const dir = folder();
    const r = await runChecks(dir, [
      { name: "ok", command: "true" },
      { name: "bad", command: "echo oops; echo more >&2; exit 3" },
      { name: "never", command: "touch ran.txt" },
    ]);
    expect(r.map((c) => [c.name, c.ok])).toEqual([["ok", true], ["bad", false]]);
    expect(r[1].output).toContain("oops");
    expect(r[1].output).toContain("more");
    expect(existsSync(path.join(dir, "ran.txt"))).toBe(false);
  });

  it("keeps only the last 40 lines of output", async () => {
    const r = await runChecks(folder(), [{ name: "loud", command: "seq 1 100" }]);
    const out = r[0].output.split("\n");
    expect(out).toHaveLength(40);
    expect(out[0]).toBe("61");
    expect(out[39]).toBe("100");
  });

  it("links the main folder's node_modules in when it has one", async () => {
    const main = folder();
    const dir = folder();
    mkdirSync(path.join(main, "node_modules"));
    writeFileSync(path.join(main, "node_modules", "dep.txt"), "x");
    const r = await runChecks(dir, [{ name: "see", command: "cat node_modules/dep.txt" }], { mainFolder: main });
    expect(lstatSync(path.join(dir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(r[0]).toMatchObject({ ok: true, output: "x" });

    const bare = folder();
    await runChecks(bare, [{ name: "n", command: "true" }], { mainFolder: folder() });
    expect(existsSync(path.join(bare, "node_modules"))).toBe(false);
  });
});

describe("defaultMergeChecks", () => {
  it("is the project's test and build scripts, when present", async () => {
    const dir = folder2();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "x", test: "y", dev: "z" } }));
    expect(await defaultMergeChecks(dir)).toEqual([
      { name: "test", command: "npm run test" },
      { name: "build", command: "npm run build" },
    ]);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "z" } }));
    expect(await defaultMergeChecks(dir)).toEqual([]);
    expect(await defaultMergeChecks(folder2())).toEqual([]);
  });
});

function folder2() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "checks-")));
}
