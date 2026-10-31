// Which files the model has read in each chat, and what they held then. The
// write tools refuse to change a file the model hasn't read, or one that
// changed since it last did, so it can't overwrite changes it never saw.
// Kept in memory: a dev server restart forgets it, and the model reads again.

import { createHash } from "node:crypto";
import { ToolError } from "./toolkit.ts";

// Chat id -> file -> hash of the content the model last saw.
const seen = new Map<string, Map<string, string>>();

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// Records that the model has seen this content of the file.
export function markRead(chatId: string, file: string, text: string) {
  let files = seen.get(chatId);
  if (!files) seen.set(chatId, (files = new Map()));
  files.set(file, hash(text));
}

// Throws unless the model has read the file and it hasn't changed since.
export function requireRead(chatId: string, file: string, text: string) {
  const last = seen.get(chatId)?.get(file);
  if (last === undefined) throw new ToolError(`read ${file} with read_file before changing it`);
  if (last !== hash(text)) throw new ToolError(`${file} changed since you last read it; read it again first`);
}
