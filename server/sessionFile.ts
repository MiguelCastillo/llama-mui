// Reading and writing one session's session.json, shared by the sessions routes
// and the run hub. Nothing here knows about runs: it is files and the shape of
// the sessions list row.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "./disk.ts";
import { HttpError } from "./http.ts";

// Ids come from the browser and become folder names, so only plain ones pass.
export function sessionFolder(id: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new HttpError(400, "Bad session id");
  return path.join(sessionsDir, id);
}

export function sessionFile(id: string): string {
  return path.join(sessionFolder(id), "session.json");
}

export async function readSession(id: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(sessionFile(id), "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Write-then-rename so a crash mid-write can't leave a truncated file.
async function writeText(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, text, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export const writeSession = (id: string, session: unknown) => writeText(sessionFile(id), JSON.stringify(session));

// The number of times the server has written this session. A session saved
// before revisions existed has none, which counts as 0.
export function revisionOf(session: any): number {
  const r = session?.revision;
  return Number.isInteger(r) && r >= 0 ? r : 0;
}

// A session's open todos as the list carries them: id and summary, no
// description, to keep the list light. Sessions saved before todos have none.
export function openTodoList(todos: unknown): { id: string; summary: string }[] {
  if (!Array.isArray(todos)) return [];
  return todos
    .filter((t) => t?.status === "open" && typeof t.id === "string" && typeof t.summary === "string")
    .map((t) => ({ id: t.id, summary: t.summary }));
}

// The row the sessions list shows for a saved session. The list, a save and a
// rename all answer with it, so the client can swap a row for the answer
// without losing a field (a nested session would jump to the top level
// without its parentId).
export function summaryOf(s: any) {
  return {
    id: String(s.id),
    title: String(s.title),
    updatedAt: Number(s.updatedAt),
    modelName: s.modelName ?? null,
    userName: s.userName ?? null,
    todos: openTodoList(s.todos),
    parentId: typeof s.parentId === "string" ? s.parentId : null,
  };
}
