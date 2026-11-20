import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workInProgress } from "../workInProgress.ts";
import { clearListCache, LIST_CACHE_MS, listSettings, mergeSettings, workInProgressRoutes } from "../workInProgressRoutes.ts";

const call = async (method: string, parts: string[], opts: { body?: unknown; search?: string } = {}) => {
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: Buffer | string) => void (text = t.toString()) } as unknown as ServerResponse;
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]) as unknown as IncomingMessage;
  let error: unknown;
  try {
    await workInProgressRoutes({ req, res, parts, method, search: opts.search ?? "" });
  } catch (e) {
    error = e;
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : undefined, error };
};

const list = (dir: string) => call("GET", ["work-in-progress"], { search: `?dir=${encodeURIComponent(dir)}` });

describe("work list cache", () => {
  let runs = 0;
  let clock = 0;
  let fail = false;

  beforeEach(() => {
    runs = 0;
    clock = 1000;
    fail = false;
    clearListCache();
    listSettings.now = () => clock;
    listSettings.load = async () => {
      runs++;
      await new Promise((ok) => setTimeout(ok, 10));
      if (fail) throw new Error("git broke");
      return [];
    };
  });
  afterEach(() => {
    listSettings.load = workInProgress;
    listSettings.now = () => Date.now();
    clearListCache();
  });

  it("runs git once for requests inside the window, including ones in flight together", async () => {
    await Promise.all([list("/x"), list("/x"), list("/x")]);
    expect(runs).toBe(1);
    clock += LIST_CACHE_MS - 1;
    await list("/x");
    expect(runs).toBe(1);
  });

  it("keeps a separate answer for each folder", async () => {
    await list("/x");
    await list("/y");
    expect(runs).toBe(2);
  });

  it("runs git again after the window", async () => {
    await list("/x");
    clock += LIST_CACHE_MS;
    await list("/x");
    expect(runs).toBe(2);
  });

  it("does not keep a failed load", async () => {
    fail = true;
    const bad = await list("/x");
    expect(bad.error).toBeTruthy();
    fail = false;
    const good = await list("/x");
    expect(good.body).toEqual([]);
    expect(runs).toBe(2);
    await list("/x");
    expect(runs).toBe(2);
  });

  it("does not keep an answer that was started before a clear", async () => {
    const slow = list("/x");
    clearListCache();
    await slow;
    await list("/x");
    expect(runs).toBe(2);
  });

  it("is cleared when a merge starts, is approved and is discarded", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "wip-cache-")));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir }).toString();
    git("init", "-b", "main");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-m", "first");
    for (const n of ["one", "two"]) {
      git("checkout", "-b", n);
      writeFileSync(path.join(dir, `${n}.txt`), n);
      git("add", "-A");
      git("commit", "-m", n);
      git("checkout", "main");
    }
    mergeSettings.integrationRoot = mkdtempSync(path.join(tmpdir(), "merge-int-"));
    mergeSettings.checks = async () => [{ name: "ok", command: "echo fine" }];
    const settle = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const r = await call("GET", ["work-in-progress", "merge", id]);
        if (!["replaying", "checking"].includes(r.body.state)) return r.body;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      throw new Error("never settled");
    };

    await list(dir);
    expect(runs).toBe(1);
    const first = await call("POST", ["work-in-progress", "merge"], { body: { dir, branch: "one" } });
    expect(first.status).toBe(202);
    await list(dir);
    expect(runs).toBe(2); // start cleared it
    await settle(first.body.id);
    await list(dir);
    expect(runs).toBe(2); // settling alone does not

    const approved = await call("POST", ["work-in-progress", "merge", first.body.id, "approve"]);
    expect(approved.body.state).toBe("merged");
    await list(dir);
    expect(runs).toBe(3);

    const second = await call("POST", ["work-in-progress", "merge"], { body: { dir, branch: "two" } });
    await settle(second.body.id);
    await list(dir);
    const before = runs;
    await list(dir);
    expect(runs).toBe(before);
    const discarded = await call("POST", ["work-in-progress", "merge", second.body.id, "discard"]);
    expect(discarded.body.state).toBe("discarded");
    await list(dir);
    expect(runs).toBe(before + 1);
  });
});
