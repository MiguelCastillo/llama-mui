import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workInProgressRoutes } from "../workInProgressRoutes.ts";

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
