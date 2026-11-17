// Handles GET /api/work-in-progress?dir=<project folder>: everything started but
// not yet in the main branch of the repo that folder is in (see workInProgress.ts).
// It is scoped by the folder, not by a session, so every chat in the same project
// gets the same list. A folder that isn't in a git repo gets an empty list.

import path from "node:path";
import { HttpError, type Route, sendJson } from "./http.ts";
import { workInProgress } from "./workInProgress.ts";

export async function workInProgressRoutes({ res, parts, method, search }: Route): Promise<boolean> {
  if (parts[0] !== "work-in-progress" || parts.length !== 1) return false;
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  const dir = new URLSearchParams(search).get("dir");
  if (!dir || !path.isAbsolute(dir)) throw new HttpError(400, "dir must be a full folder path");
  sendJson(res, 200, await workInProgress(dir));
  return true;
}
