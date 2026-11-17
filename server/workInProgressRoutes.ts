// Handles /api/work-in-progress:
//   GET  ?dir=<project folder>   everything started but not yet in the main branch
//        of the repo that folder is in (see workInProgress.ts). It is scoped by the
//        folder, not by a session, so every chat in the same project gets the same
//        list. A folder that isn't in a git repo gets an empty list.
//   POST /merge {dir, branch}    starts merging one branch into main (replay, then
//        checks, in the background) and returns an attempt id.
//   GET  /merge/<id>             the attempt's state.
//   POST /merge/<id>/approve     moves main (only when the checks passed).
//   POST /merge/<id>/discard     throws the attempt away.
// Attempts live in memory; there is at most one live attempt per repo.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "./io/exec.ts";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import {
  approveMerge,
  type CheckResult,
  discardMerge,
  type MergeAttempt,
  MergeError,
  type MergeCheck,
  mergeChecksFor,
  type PreparedMerge,
  prepareMerge,
  runChecks,
} from "./integration.ts";
import { workInProgress } from "./workInProgress.ts";

export type MergeState = "replaying" | "checking" | "ready" | "failed" | "conflict" | "merged" | "discarded" | "error";

interface Attempt {
  id: string;
  repo: string;
  branch: string;
  state: MergeState;
  check?: string;
  checks: CheckResult[];
  files?: string[];
  message?: string;
  replayed?: number;
  prepared?: PreparedMerge;
}

const attempts = new Map<string, Attempt>();
// A failed or ready attempt still holds an integration folder, so it stays live
// until it is approved or discarded.
const LIVE: MergeState[] = ["replaying", "checking", "ready", "failed"];

// Seams for tests: where integration folders go, and which checks run.
export const mergeSettings: { integrationRoot?: string; checks?: (repo: string) => Promise<MergeCheck[]> } = {};

const view = (a: Attempt) => ({
  id: a.id,
  branch: a.branch,
  state: a.state,
  ...(a.check ? { check: a.check } : {}),
  checks: a.checks,
  ...(a.files ? { files: a.files } : {}),
  ...(a.message ? { message: a.message } : {}),
  ...(a.replayed !== undefined ? { replayed: a.replayed } : {}),
});

async function repoRoot(dir: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 15_000 }, { why: "git.merge" });
    return await realpath(stdout.trim());
  } catch {
    throw new HttpError(400, "That folder is not in a git repository.");
  }
}

async function run(a: Attempt): Promise<void> {
  try {
    const prepared = await prepareMerge(a.repo, a.branch, { integrationRoot: mergeSettings.integrationRoot });
    if (prepared.conflict) {
      a.state = "conflict";
      a.files = prepared.files;
      return;
    }
    a.prepared = prepared;
    a.replayed = prepared.replayed;
    a.state = "checking";
    const checks = await (mergeSettings.checks ?? mergeChecksFor)(prepared.repo);
    const results = await runChecks(prepared.folder, checks, { mainFolder: prepared.repo, onStart: (n) => void (a.check = n) });
    a.checks = results;
    a.check = undefined;
    a.state = results.length === checks.length && results.every((c) => c.ok) ? "ready" : "failed";
  } catch (e) {
    a.state = "error";
    a.message = e instanceof MergeError ? e.message : `The merge could not be prepared: ${(e as Error)?.message ?? e}`;
  }
}

const find = (id: string): Attempt => {
  const a = attempts.get(id);
  if (!a) throw new HttpError(404, "No such merge attempt (the app may have restarted).");
  return a;
};

const asAttempt = (a: Attempt): MergeAttempt => {
  if (!a.prepared) throw new HttpError(409, "This merge has not been prepared.");
  return { ...a.prepared, checks: a.checks, expectedChecks: a.checks.length };
};

async function mergeRoutes({ req, res, parts, method }: Route): Promise<void> {
  if (parts.length === 2) {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);
    const dir = body?.dir;
    const branch = body?.branch;
    if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new HttpError(400, "dir must be a full folder path");
    if (typeof branch !== "string" || !branch.trim()) throw new HttpError(400, "Only a branch can be merged; loose files cannot.");
    const repo = await repoRoot(dir);
    const entries = await workInProgress(repo);
    const entry = entries.find((e) => e.kind !== "loose" && e.branch === branch);
    if (!entry) {
      const base = await execFile("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, timeout: 15_000 }, { why: "git.merge" })
        .then((r) => r.stdout.trim())
        .catch(() => "");
      throw new HttpError(400, branch === base ? "That is the main branch itself." : `There is nothing to merge on a branch called ${branch}.`);
    }
    if (entry.merged) throw new HttpError(409, "That branch is already merged.");
    for (const a of attempts.values()) {
      if (a.repo === repo && LIVE.includes(a.state)) {
        throw new HttpError(409, `A merge of ${a.branch} is already in progress for this project. Approve or discard it first.`);
      }
    }
    const a: Attempt = { id: randomUUID(), repo, branch, state: "replaying", checks: [] };
    attempts.set(a.id, a);
    void run(a);
    sendJson(res, 202, view(a));
    return;
  }

  const a = find(parts[2]);
  if (parts.length === 3) {
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    sendJson(res, 200, view(a));
    return;
  }
  if (parts.length !== 4 || (parts[3] !== "approve" && parts[3] !== "discard")) throw new HttpError(404, "Not found");
  if (method !== "POST") throw new HttpError(405, "Method not allowed");

  if (parts[3] === "approve") {
    if (a.state !== "ready") throw new HttpError(409, "Only a merge whose checks have passed can be approved.");
    try {
      await approveMerge(a.repo, asAttempt(a));
    } catch (e) {
      if (e instanceof MergeError) throw new HttpError(409, e.message);
      throw e;
    }
    a.state = "merged";
  } else {
    if (!LIVE.includes(a.state) || a.state === "replaying" || a.state === "checking") {
      throw new HttpError(409, a.state === "replaying" || a.state === "checking" ? "Wait for the checks to finish before discarding." : "This merge is already over.");
    }
    await discardMerge(a.repo, asAttempt(a));
    a.state = "discarded";
  }
  sendJson(res, 200, view(a));
}

export async function workInProgressRoutes(route: Route): Promise<boolean> {
  const { res, parts, method, search } = route;
  if (parts[0] !== "work-in-progress") return false;
  if (parts[1] === "merge" && parts.length >= 2) {
    await mergeRoutes(route);
    return true;
  }
  if (parts.length !== 1) return false;
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  const dir = new URLSearchParams(search).get("dir");
  if (!dir || !path.isAbsolute(dir)) throw new HttpError(400, "dir must be a full folder path");
  sendJson(res, 200, await workInProgress(dir));
  return true;
}
