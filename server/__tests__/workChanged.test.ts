import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp one.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { toolRoutes } = await import("../tools.ts");
const hub = await import("../runHub.ts");
const { workInProgress } = await import("../workInProgress.ts");
const { clearListCache, listSettings, mergeSettings, workInProgressRoutes } = await import("../workInProgressRoutes.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const repo = path.join(home.dir, "Projects", "app");
await mkdir(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
await writeFile(path.join(repo, "a.txt"), "a\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");
git(repo, "checkout", "-q", "-b", "feature");
await writeFile(path.join(repo, "b.txt"), "b\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "work");
git(repo, "checkout", "-q", "main");

const tool = async (name: string, args: object, approved?: object) => {
  const body = { name, arguments: args, chatId: "wc-1", attachments: [], approved };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "call"], method: "POST", search: "" });
  return JSON.parse(text);
};

const route = async (method: string, parts: string[], opts: { body?: unknown; search?: string } = {}) => {
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: Buffer | string) => void (text = t.toString()) } as unknown as ServerResponse;
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]) as unknown as IncomingMessage;
  await workInProgressRoutes({ req, res, parts, method, search: opts.search ?? "" });
  return text ? JSON.parse(text) : undefined;
};
const list = () => route("GET", ["work-in-progress"], { search: `?dir=${encodeURIComponent(repo)}` });

describe("the work event", () => {
  let runs = 0;
  let heard: { cacheWasClear: boolean }[] = [];
  let events = 0;
  let off: () => void;

  beforeEach(() => {
    runs = 0;
    heard = [];
    events = 0;
    clearListCache();
    listSettings.load = async (dir: string) => {
      runs++;
      return workInProgress(dir);
    };
    mergeSettings.integrationRoot = path.join(home.dir, "integration");
    mergeSettings.checks = async () => [{ name: "ok", command: "echo fine" }];
    off = hub.subscribe((e) => {
      if (e.type !== "work") return;
      events++;
      // Asking for the list right now must run git: the saved answer is already gone.
      const before = runs;
      void list().then(() => heard.push({ cacheWasClear: runs === before + 1 }));
    });
  });
  afterEach(() => {
    off();
    listSettings.load = workInProgress;
    clearListCache();
  });

  const count = () => events;
  // Waits until every event heard so far has had its list request answered.
  const settle = async () => {
    await new Promise((ok) => setTimeout(ok, 50));
    for (let i = 0; i < 100 && heard.length < events; i++) await new Promise((ok) => setTimeout(ok, 50));
  };

  it("is sent once, with the cache already clear, for a merge start, approval and discard", async () => {
    await list();
    const started = await route("POST", ["work-in-progress", "merge"], { body: { dir: repo, branch: "feature" } });
    await settle();
    expect(count()).toBe(1);
    expect(heard[0].cacheWasClear).toBe(true);
    for (let i = 0; i < 100; i++) {
      if ((await route("GET", ["work-in-progress", "merge", started.id])).state === "ready") break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    await route("POST", ["work-in-progress", "merge", started.id, "approve"]);
    await settle();
    expect(count()).toBe(2);
    expect(heard[1].cacheWasClear).toBe(true);

    git(repo, "checkout", "-q", "-b", "other");
    await writeFile(path.join(repo, "c.txt"), "c\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more");
    git(repo, "checkout", "-q", "main");
    const second = await route("POST", ["work-in-progress", "merge"], { body: { dir: repo, branch: "other" } });
    for (let i = 0; i < 100; i++) {
      if ((await route("GET", ["work-in-progress", "merge", second.id])).state === "ready") break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    await settle();
    const before = count();
    await route("POST", ["work-in-progress", "merge", second.id, "discard"]);
    await settle();
    expect(count()).toBe(before + 1);
    expect(heard[before].cacheWasClear).toBe(true);
  });

  it("is sent once when a worktree is made, and not when making one fails", async () => {
    await tool("create_worktree", { repo, name: "ev" });
    await settle();
    expect(count()).toBe(1);
    expect(heard[0].cacheWasClear).toBe(true);
    const again = await tool("create_worktree", { repo, name: "ev" });
    expect(again.result).toContain("already exists");
    await tool("create_worktree", { repo: path.join(home.dir, "nowhere"), name: "x" });
    await settle();
    expect(count()).toBe(1);
  });

  it("is sent once when a worktree is removed, and not when removal is refused or fails", async () => {
    await tool("create_worktree", { repo, name: "gone" });
    await settle();
    const before = count();
    const first = await tool("remove_worktree", { name: "gone" });
    expect(first.needsApproval).toBeTruthy();
    await tool("remove_worktree", { name: "ghost" });
    await settle();
    expect(count()).toBe(before);
    await tool("remove_worktree", { name: "gone" }, first.needsApproval);
    await settle();
    expect(count()).toBe(before + 1);
    expect(heard[before].cacheWasClear).toBe(true);
  });
});
