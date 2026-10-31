// Saved chats ("sessions"), one JSON file each in ~/.llama-mui/chats, so
// reloading the page, or coming back later, picks up where you left off. The
// files stay on this machine, outside the project, readable only by you.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";

const CHATS_DIR = path.join(os.homedir(), ".llama-mui", "chats");

// Ids come from the browser and become file names, so only plain ones pass.
function fileFor(id: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new HttpError(400, "Bad session id");
  return path.join(CHATS_DIR, `${id}.json`);
}

async function readSession(id: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(fileFor(id), "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Handles /api/chats; returns false for anything else.
//   GET          → [{ id, title, updatedAt }], newest first
//   GET /<id>    → the saved session
//   PUT /<id>    → saves it; the server sets createdAt and updatedAt
//   DELETE /<id> → deletes it
export async function chatRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "chats") return false;

  if (parts.length === 1 && method === "GET") {
    const names = await readdir(CHATS_DIR).catch(() => [] as string[]);
    const sessions = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => readSession(n.slice(0, -5)).catch(() => null)),
    );
    const list = sessions
      .filter((s) => s !== null)
      .map((s) => ({ id: String(s.id), title: String(s.title), updatedAt: Number(s.updatedAt) }))
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
    const file = fileFor(id);
    const old = await readSession(id);
    const now = Date.now();
    const title = String(body.title ?? "New chat").slice(0, 100);
    const session = { ...body, id, title, createdAt: old?.createdAt ?? now, updatedAt: now };
    await mkdir(CHATS_DIR, { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    await writeFile(`${file}.tmp`, JSON.stringify(session), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    sendJson(res, 200, { id, title, updatedAt: now });
    return true;
  }
  if (method === "DELETE") {
    await rm(fileFor(id), { force: true });
    sendJson(res, 200, { id });
    return true;
  }
  return false;
}