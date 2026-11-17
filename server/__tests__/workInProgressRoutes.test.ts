import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { mergeSettings, workInProgressRoutes } from "../workInProgressRoutes.ts";

const invoke = async (method: string, parts: string[], search: string) => {
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: Buffer | string) => void (text = t.toString()) } as unknown as ServerResponse;
  let error: { status?: number } | undefined;
  let handled = false;
  try {
    handled = await workInProgressRoutes({ req: {} as IncomingMessage, res, parts, method, search });
  } catch (e) {
    error = e as { status?: number };
  }
  return { handled, status: res.statusCode, body: text ? JSON.parse(text) : undefined, error };
};

const call = async (method: string, parts: string[], body?: unknown) => {
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: Buffer | string) => void (text = t.toString()) } as unknown as ServerResponse;
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let error: { status?: number; message?: string } | undefined;
  try {
    await workInProgressRoutes({ req, res, parts, method, search: "" });
  } catch (e) {
    error = e as { status?: number };
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : undefined, error };
};

const settle = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const r = await call("GET", ["work-in-progress", "merge", id]);
    if (!["replaying", "checking"].includes(r.body.state)) return r.body;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("attempt never settled");
};

describe("merge routes", () => {
  const made = (): { dir: string; git: (...a: string[]) => string } => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "merge-route-")));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir }).toString();
    git("init", "-b", "main");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-m", "first");
    mergeSettings.integrationRoot = mkdtempSync(path.join(tmpdir(), "merge-int-"));
    mergeSettings.checks = async () => [{ name: "ok", command: "echo fine" }];
    return { dir, git };
  };
  const branchWith = (git: (...a: string[]) => string, dir: string, name: string, file: string, text: string) => {
    git("checkout", "-b", name);
    writeFileSync(path.join(dir, file), text);
    git("add", "-A");
    git("commit", "-m", `work on ${name}`);
    git("checkout", "main");
  };

  it("replays, checks, then approving moves main", async () => {
    const { dir, git } = made();
    branchWith(git, dir, "feature", "b.txt", "b\n");
    const started = await call("POST", ["work-in-progress", "merge"], { dir, branch: "feature" });
    expect(started.status).toBe(202);
    expect(started.body.state).toBe("replaying");
    const ready = await settle(started.body.id);
    expect(ready.state).toBe("ready");
    expect(ready.checks).toHaveLength(1);
    expect(ready.replayed).toBe(1);
    const done = await call("POST", ["work-in-progress", "merge", started.body.id, "approve"]);
    expect(done.body.state).toBe("merged");
    expect(git("log", "--format=%s", "main")).toContain("work on feature");
  });

  it("reports a failed check, keeps main, and allows discard", async () => {
    const { dir, git } = made();
    mergeSettings.checks = async () => [{ name: "boom", command: "echo bad; exit 1" }];
    branchWith(git, dir, "feature", "b.txt", "b\n");
    const before = git("rev-parse", "main");
    const id = (await call("POST", ["work-in-progress", "merge"], { dir, branch: "feature" })).body.id;
    const failed = await settle(id);
    expect(failed.state).toBe("failed");
    expect(failed.checks[0].output).toContain("bad");
    expect((await call("POST", ["work-in-progress", "merge", id, "approve"])).error?.status).toBe(409);
    expect(git("rev-parse", "main")).toBe(before);
    const gone = await call("POST", ["work-in-progress", "merge", id, "discard"]);
    expect(gone.body.state).toBe("discarded");
    expect(git("branch", "--list", "llama/integration/*").trim()).toBe("");
  });

  it("shows the checking state with the current check's name", async () => {
    const { dir, git } = made();
    mergeSettings.checks = async () => [{ name: "slow", command: "sleep 1; echo done" }];
    branchWith(git, dir, "feature", "b.txt", "b\n");
    const id = (await call("POST", ["work-in-progress", "merge"], { dir, branch: "feature" })).body.id;
    let seen: { state: string; check?: string } | undefined;
    for (let i = 0; i < 100 && !seen; i++) {
      const r = await call("GET", ["work-in-progress", "merge", id]);
      if (r.body.state === "checking" && r.body.check) seen = r.body;
      else await new Promise((ok) => setTimeout(ok, 20));
    }
    expect(seen?.check).toBe("slow");
    expect((await settle(id)).state).toBe("ready");
    await call("POST", ["work-in-progress", "merge", id, "discard"]);
  });

  it("shows the error state with a plain message when the merge cannot be prepared", async () => {
    const { dir, git } = made();
    mergeSettings.checks = async () => {
      throw new Error("settings unreadable");
    };
    branchWith(git, dir, "feature", "b.txt", "b\n");
    const id = (await call("POST", ["work-in-progress", "merge"], { dir, branch: "feature" })).body.id;
    const r = await settle(id);
    expect(r.state).toBe("error");
    expect(r.message).toContain("settings unreadable");
    // An error is not live: a new start is allowed.
    await call("POST", ["work-in-progress", "merge", id, "discard"]).then((d) => expect(d.error?.status).toBe(409));
  });

  it("refuses approval when main moved, and keeps the attempt ready", async () => {
    const { dir, git } = made();
    branchWith(git, dir, "feature", "b.txt", "b\n");
    const id = (await call("POST", ["work-in-progress", "merge"], { dir, branch: "feature" })).body.id;
    expect((await settle(id)).state).toBe("ready");
    writeFileSync(path.join(dir, "c.txt"), "c\n");
    git("add", "c.txt");
    git("commit", "-m", "main moved");
    const moved = git("rev-parse", "main");
    const r = await call("POST", ["work-in-progress", "merge", id, "approve"]);
    expect(r.error?.status).toBe(409);
    expect(r.error?.message).toMatch(/moved/);
    expect(git("rev-parse", "main")).toBe(moved);
    expect((await call("GET", ["work-in-progress", "merge", id])).body.state).toBe("ready");
    await call("POST", ["work-in-progress", "merge", id, "discard"]);
  });

  it("reports the clashing files for a conflict and leaves main alone", async () => {
    const { dir, git } = made();
    branchWith(git, dir, "feature", "a.txt", "from branch\n");
    writeFileSync(path.join(dir, "a.txt"), "from main\n");
    git("commit", "-am", "main edit");
    const before = git("rev-parse", "main");
    const id = (await call("POST", ["work-in-progress", "merge"], { dir, branch: "feature" })).body.id;
    const r = await settle(id);
    expect(r.state).toBe("conflict");
    expect(r.files).toEqual(["a.txt"]);
    expect(git("rev-parse", "main")).toBe(before);
  });

  it("refuses a second live attempt in the same repo, then allows one after discard", async () => {
    const { dir, git } = made();
    branchWith(git, dir, "one", "b.txt", "b\n");
    branchWith(git, dir, "two", "c.txt", "c\n");
    const id = (await call("POST", ["work-in-progress", "merge"], { dir, branch: "one" })).body.id;
    const second = await call("POST", ["work-in-progress", "merge"], { dir, branch: "two" });
    expect(second.error?.status).toBe(409);
    expect(second.error?.message).toMatch(/already in progress/);
    await settle(id);
    await call("POST", ["work-in-progress", "merge", id, "discard"]);
    expect((await call("POST", ["work-in-progress", "merge"], { dir, branch: "two" })).status).toBe(202);
  });

  it("refuses loose files, the main branch, unknown ids and a branch with nothing to merge", async () => {
    const { dir, git } = made();
    expect((await call("POST", ["work-in-progress", "merge"], { dir })).error?.status).toBe(400);
    expect((await call("POST", ["work-in-progress", "merge"], { dir, branch: "main" })).error?.message).toMatch(/main branch itself/);
    expect((await call("POST", ["work-in-progress", "merge"], { dir: "relative", branch: "x" })).error?.status).toBe(400);
    expect((await call("POST", ["work-in-progress", "merge"], { dir, branch: "nope" })).error?.status).toBe(400);
    expect((await call("GET", ["work-in-progress", "merge", "missing"])).error?.status).toBe(404);
    git("branch", "same");
    expect((await call("POST", ["work-in-progress", "merge"], { dir, branch: "same" })).error?.status).toBe(400);
  });
});

describe("GET /api/work-in-progress", () => {
  it("ignores other paths", async () => {
    expect((await invoke("GET", ["sessions"], "")).handled).toBe(false);
  });

  it("returns an empty list for a folder that is not a git repo", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "nogit-")));
    const r = await invoke("GET", ["work-in-progress"], `?dir=${encodeURIComponent(dir)}`);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("lists uncommitted files of the repo the folder is in", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "wip-route-")));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir });
    git("init", "-b", "main");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-m", "first");
    writeFileSync(path.join(dir, "b.txt"), "b\n");
    const r = await invoke("GET", ["work-in-progress"], `?dir=${encodeURIComponent(dir)}`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].kind).toBe("loose");
  });

  it("refuses a missing or relative folder and other methods", async () => {
    expect((await invoke("GET", ["work-in-progress"], "")).error?.status).toBe(400);
    expect((await invoke("GET", ["work-in-progress"], "?dir=relative")).error?.status).toBe(400);
    expect((await invoke("POST", ["work-in-progress"], "?dir=/tmp")).error?.status).toBe(405);
  });
});
