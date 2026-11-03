// Saved sessions, one folder each in ~/.llama-mui/sessions/<id>/ with the
// session itself in session.json, so reloading the page, or coming back later,
// picks up where you left off. The files stay on this machine, outside the
// project, readable only by you. The folder's worktrees/ is the one part the
// model may change without asking (see inSessionWorktrees in disk.ts), so
// session.json can't be rewritten by it.

import { readdir, readFile, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sessionsDir } from "./disk.ts";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import * as hub from "./runHub.ts";
import { deleteSession, readSession, revisionOf, sessionFolder, summaryOf, writeSession } from "./sessionFile.ts";

// Other modules (and tests) have always got these from here.
export { openTodoList, sessionFolder, summaryOf } from "./sessionFile.ts";

// Sessions used to be single files here, named <id>.json.
const OLD_CHATS_DIR = path.join(os.homedir(), ".llama-mui", "chats");

// Moves each old chat file into its session folder. A file is removed only
// after the copy is read back and matches; one that doesn't parse, whose id
// isn't its name, or whose session already has a session.json stays where it
// is, so nothing is lost.
async function migrateChats(): Promise<void> {
  const names = await readdir(OLD_CHATS_DIR).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const id = name.slice(0, -5);
    try {
      const old = JSON.parse(await readFile(path.join(OLD_CHATS_DIR, name), "utf8"));
      if (old.id !== id || (await readSession(id))) continue;
      await writeSession(id, old);
      if (JSON.stringify(await readSession(id)) === JSON.stringify(old)) await rm(path.join(OLD_CHATS_DIR, name));
    } catch (e) {
      console.warn(`Couldn't move ${name} to sessions: ${e}`);
    }
  }
  await rmdir(OLD_CHATS_DIR).catch(() => {}); // only works once it's empty
}

let migration: Promise<void> | undefined;

// Handles /api/sessions; returns false for anything else.
//   GET          → [summary], newest first; a summary is { id, title, updatedAt,
//                  modelName, userName, todos, parentId } (see summaryOf)
//   GET /<id>    → the saved session, with its `revision` (0 if it never had one)
//                  and `run` while a plan is running in it in this process
//   PUT /<id>    → saves it; the server sets createdAt, updatedAt and revision;
//                  answers with its summary plus the new `revision`. Send the
//                  `revision` the page loaded: if the file has moved on it answers
//                  409 { error, revision } and saves nothing. While a plan runs in
//                  the session, every PUT is a 409 (the run owns the session).
//   PATCH /<id>  → updates only the name fields, keeps updatedAt; answers with its
//                  summary plus `revision`. While a plan runs it goes through the
//                  run's live session.
//   DELETE /<id> → deletes its session.json, and its folder if nothing else is in
//                  it; a 409 while a plan runs in it
export async function sessionRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "sessions") return false;
  // Before the first request is answered, so a list never misses a session still in the old folder.
  await (migration ??= migrateChats());

  if (parts.length === 1 && method === "GET") {
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    const sessions = await Promise.all(names.map((n) => readSession(n).catch(() => null)));
    const list = sessions
      .filter((s) => s !== null)
      .map(summaryOf)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    sendJson(res, 200, list);
    return true;
  }
  if (parts.length !== 2) return false;
  const id = parts[1];

  if (method === "GET") {
    const session = await readSession(id);
    if (!session) throw new HttpError(404, "No such session");
    // `run` is the run live in this process, never a record a crash left in the file.
    const { run: _recorded, ...saved } = session;
    const run = hub.liveRun(id);
    sendJson(res, 200, { ...saved, revision: revisionOf(session), ...(run ? { run } : {}) });
    return true;
  }
  if (method === "PUT") {
    const body = await readJson(req);
    if (!Array.isArray(body.messages)) throw new HttpError(400, "messages must be a list");
    const sent = body.revision;
    if (sent !== undefined && !(Number.isInteger(sent) && sent >= 0)) throw new HttpError(400, "revision must be a whole number");
    const { session, revision } = await hub.replace(
      id,
      (old) => {
        const now = Date.now();
        // The names are PATCH's, never a save's: a save from a copy made before
        // the model named the session wiped the name out. The title follows them.
        const modelName = old?.modelName ?? body.modelName ?? null;
        const userName = old ? (old.userName ?? null) : (body.userName ?? null);
        const title = String(userName ?? modelName ?? body.title ?? "New session").slice(0, 100);
        return { ...body, id, title, modelName, userName, createdAt: old?.createdAt ?? now, updatedAt: now };
      },
      sent,
    );
    sendJson(res, 200, { ...summaryOf(session), revision });
    return true;
  }
  if (method === "PATCH") {
    const body = await readJson(req);
    const { session, revision } = await hub.edit(id, (s) => {
      if (body.title !== undefined) s.title = String(body.title).slice(0, 100);
      if (body.modelName !== undefined) s.modelName = body.modelName;
      if (body.userName !== undefined) s.userName = body.userName;
    });
    sendJson(res, 200, { ...summaryOf(session), revision });
    return true;
  }
  if (method === "DELETE") {
    sessionFolder(id); // a bad id is a 400
    await hub.remove(id, () => deleteSession(id));
    sendJson(res, 200, { id });
    return true;
  }
  return false;
}
