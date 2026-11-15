// The last few working directories chosen, newest first, in their own small
// file in ~/.llama-mui: paths on this machine, which is where every working
// directory lives (the server reads it and runs commands in it), so every
// browser that opens the app sees the same list. Not in settings.json, which
// holds API keys; this file holds no secrets.

import { readFile } from "node:fs/promises";
import * as fsio from "./io/fs.ts";
import os from "node:os";
import path from "node:path";

// How many working directories are remembered.
export const RECENT_FOLDERS = 5;

// Read at call time, not at load, so a test can point the home folder elsewhere.
const recentFile = () => path.join(os.homedir(), ".llama-mui", "recent-folders.json");

// The list after `folder` is chosen: it moves to the top, the oldest drop off.
export const withFolder = (list: string[], folder: string): string[] =>
  [folder, ...list.filter((f) => f !== folder)].slice(0, RECENT_FOLDERS);

// A missing or unreadable file is an empty list; the next choice starts a new one.
export async function readRecentFolders(): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(recentFile(), "utf8"));
    return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string").slice(0, RECENT_FOLDERS) : [];
  } catch {
    return [];
  }
}

export async function writeRecentFolders(list: string[]): Promise<void> {
  const file = recentFile();
  await fsio.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }, { why: "recent-folders.save" });
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  await fsio.write(`${file}.tmp`, JSON.stringify(list), undefined, { why: "recent-folders.save" });
  await fsio.rename(`${file}.tmp`, file, { why: "recent-folders.save" });
}
