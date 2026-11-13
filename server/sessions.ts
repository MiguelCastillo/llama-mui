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
import { descendantIds } from "../src/sessionTree.ts";
import { personaToSave } from "../src/persona.ts";
import { worktreeStatuses } from "./worktreeStatus.ts";
import { convertWorkingDir, deleteSession, queueFieldsOf, readSession, revisionOf, sessionFolder, summaryOf, writeSession } from "./sessionFile.ts";

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
      // Reading converts a session with no workingDir (see convertWorkingDir),
      // so the copy is compared with the old file as it reads.
      if (JSON.stringify(await readSession(id)) === JSON.stringify(convertWorkingDir(old))) await rm(path.join(OLD_CHATS_DIR, name));
    } catch (e) {
      console.warn(`Couldn't move ${name} to sessions: ${e}`);
    }
  }
  await rmdir(OLD_CHATS_DIR).catch(() => {}); // only works once it's empty
}

let migration: Promise<void> | undefined;

// Handles /api/sessions; returns false for anything else.
//   GET          → [summary], newest first; a summary is { id, title, updatedAt,
//                  modelName, userName, group, todos, parentId } (see summaryOf)
//   GET /<id>    → the saved session, with its `revision` (0 if it never had one)
//                  and `run` while a plan is running in it in this process
//   GET /<id>/worktrees → [{ name, branch, uncommitted, unmerged, base }], one per
//                  worktree the session created (its create_worktree calls), read from git (see worktreeStatus.ts)
//   PUT /<id>    → saves it; the server sets createdAt, updatedAt and revision;
//                  answers with its summary plus the new `revision`. The queue of
//                  messages sent during a reply (`queue`, `queuePaused`) is the
//                  server's: a save keeps what the file has and ignores the body's. Send the
//                  `revision` the page loaded: if the file has moved on it answers
//                  409 { error, revision } and saves nothing. While a plan runs in
//                  the session, every PUT is a 409 (the run owns the session).
//   PATCH /<id>  → updates only the name fields and the group, keeps updatedAt; answers with its
//                  summary plus `revision`. While a plan runs it goes through the
//                  run's live session.
//   DELETE /<id> → deletes its session.json, and its folder if nothing else is in
//                  it, together with every session nested under it (any depth);
//                  answers { id, deleted: [ids, the session last] }. A 409, with
//                  nothing deleted, while a plan runs in it or in any of them
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
  // Where the session's work lives, computed from git each time (see worktreeStatus.ts).
  if (parts.length === 3 && parts[2] === "worktrees" && method === "GET") {
    const session = await readSession(parts[1]);
    sendJson(res, 200, session ? await worktreeStatuses(parts[1], session.messages) : []);
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
        const group = old ? (old.group ?? null) : (body.group ?? null); // a PATCH's too
        const title = String(userName ?? modelName ?? body.title ?? "New session").slice(0, 100);
        // The chat's connection is kept when it is text and dropped otherwise.
        const { connectorId, queue: _queue, queuePaused: _paused, ...rest } = body;
        const connection = typeof connectorId === "string" && connectorId ? { connectorId } : {};
        // The queue is the server's, like the names: a save from a copy made
        // before a message was queued or sent must not bring it back or lose it.
        // A new session has none, whatever the body says.
        const queue = queueFieldsOf(old);
        // The persona's name is fixed once the chat has started: a save can
        // choose it before then, never change it after (see personaToSave).
        const { persona: _sentPersona, ...others } = rest;
        const persona = personaToSave(old, _sentPersona);
        return {
          ...others,
          ...connection,
          ...(persona ? { persona } : {}),
          id,
          title,
          modelName,
          userName,
          group,
          ...queue,
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
        };
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
      // The group a top-level session is listed under; empty or null: none.
      if (body.group !== undefined) s.group = body.group === null ? null : String(body.group).trim().slice(0, 60) || null;
    });
    sendJson(res, 200, { ...summaryOf(session), revision });
    return true;
  }
  if (method === "DELETE") {
    sessionFolder(id); // a bad id is a 400
    // The session goes with every session nested under it, at any depth. A run
    // in any of them refuses the whole delete before anything is removed, so a
    // family is never left half deleted. A worktree in a folder is still kept
    // (see deleteSession).
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    const rows = (await Promise.all(names.map((n) => readSession(n).catch(() => null)))).filter((s) => s !== null).map(summaryOf);
    const nested = descendantIds(rows, id);
    if ([id, ...nested].some((s) => hub.liveRun(s))) {
      throw new HttpError(
        409,
        nested.length === 0
          ? "A plan is running in this session. Stop it first."
          : "A plan is running in this session or in one nested under it. Stop it first.",
        { reason: "run active" },
      );
    }
    // The deepest first, so a parent is never left pointing at nothing.
    const deleted = [...nested.reverse(), id];
    for (const gone of deleted) await hub.remove(gone, () => deleteSession(gone));
    sendJson(res, 200, { id, deleted });
    return true;
  }
  return false;
}
