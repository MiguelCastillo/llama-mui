// Saved sessions, one folder each in ~/.llama-mui/sessions/<id>/ with the
// session itself in session.json, so reloading the page, or coming back later,
// picks up where you left off. The files stay on this machine, outside the
// project, readable only by you. The folder's worktrees/ is the one part the
// model may change without asking (see inSessionWorktrees in disk.ts), so
// session.json can't be rewritten by it.

import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sessionsDir } from "./disk.ts";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";

// Sessions used to be single files here, named <id>.json.
const OLD_CHATS_DIR = path.join(os.homedir(), ".llama-mui", "chats");

// Ids come from the browser and become folder names, so only plain ones pass.
function fileFor(id: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new HttpError(400, "Bad session id");
  return path.join(sessionsDir, id, "session.json");
}

async function readSession(id: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(fileFor(id), "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function writeSession(id: string, session: unknown) {
  const file = fileFor(id);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  await writeFile(`${file}.tmp`, JSON.stringify(session), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

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
//   GET          → [{ id, title, updatedAt }], newest first
//   GET /<id>    → the saved session
//   PUT /<id>    → saves it; the server sets createdAt and updatedAt
//   PATCH /<id>  → updates only the name fields, keeps updatedAt
//   DELETE /<id> → deletes its session.json, and its folder if nothing else is in it
export async function sessionRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "sessions") return false;
  // Before the first request is answered, so a list never misses a session still in the old folder.
  await (migration ??= migrateChats());

  if (parts.length === 1 && method === "GET") {
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    const sessions = await Promise.all(names.map((n) => readSession(n).catch(() => null)));
    const list = sessions
      .filter((s) => s !== null)
      .map((s) => ({
        id: String(s.id),
        title: String(s.title),
        updatedAt: Number(s.updatedAt),
        modelName: s.modelName ?? null,
        userName: s.userName ?? null,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    sendJson(res, 200, list);
    return true;
  }
  if (parts.length !== 2) return false;
  const id = parts[1];

  if (method === "GET") {
    const session = await readSession(id);
    if (!session) throw new HttpError(404, "No such session");
    sendJson(res, 200, session);
    return true;
  }
  if (method === "PUT") {
    const body = await readJson(req);
    if (!Array.isArray(body.messages)) throw new HttpError(400, "messages must be a list");
    const old = await readSession(id);
    const now = Date.now();
    // The names are PATCH's, never a save's: a save from a copy made before
    // the model named the session wiped the name out. The title follows them.
    const modelName = old?.modelName ?? body.modelName ?? null;
    const userName = old ? (old.userName ?? null) : (body.userName ?? null);
    const title = String(userName ?? modelName ?? body.title ?? "New session").slice(0, 100);
    const session = { ...body, id, title, modelName, userName, createdAt: old?.createdAt ?? now, updatedAt: now };
    await writeSession(id, session);
    sendJson(res, 200, { id, title, updatedAt: now });
    return true;
  }
  if (method === "PATCH") {
    const body = await readJson(req);
    const old = await readSession(id);
    if (!old) throw new HttpError(404, "No such session");
    const title = body.title !== undefined ? String(body.title).slice(0, 100) : old.title;
    const session = {
      ...old,
      title,
      modelName: body.modelName !== undefined ? body.modelName : old.modelName,
      userName: body.userName !== undefined ? body.userName : old.userName,
    };
    await writeSession(id, session);
    sendJson(res, 200, { id, title, updatedAt: old.updatedAt });
    return true;
  }
  if (method === "DELETE") {
    const file = fileFor(id);
    await rm(file, { force: true });
    // A worktree in the folder is the user's work: the folder only goes if it's empty.
    await rmdir(path.dirname(file)).catch(() => {});
    sendJson(res, 200, { id });
    return true;
  }
  return false;
}
