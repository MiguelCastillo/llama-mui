// The agent's own instructions: a plain markdown file the user edits in
// Settings → Agent, added to the system prompt (see toolsSystemPrompt). Not in
// settings.json, which holds API keys; this file holds no secrets.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";

// Missing file means this; an empty file means no extra instructions.
export const DEFAULT_INSTRUCTIONS =
  "After you commit, run `git --no-pager show --stat --oneline HEAD` and tell the user which files went in.";

// Every request carries it, so it can't be allowed to fill the context.
export const MAX_INSTRUCTIONS = 20_000;

// Read at call time, not at load, so a test can point the home folder elsewhere.
const instructionsFile = () => path.join(os.homedir(), ".llama-mui", "instructions.md");

export async function readInstructions(): Promise<{ text: string; isDefault: boolean }> {
  try {
    return { text: await readFile(instructionsFile(), "utf8"), isDefault: false };
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    return { text: DEFAULT_INSTRUCTIONS, isDefault: true };
  }
}

// Handles /api/instructions; returns false for anything else.
export async function instructionRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "instructions" || parts.length !== 1) return false;

  if (method === "GET") {
    sendJson(res, 200, await readInstructions());
    return true;
  }

  if (method === "PUT") {
    const { text } = await readJson(req);
    if (typeof text !== "string") throw new HttpError(400, "text must be a string");
    if (text.length > MAX_INSTRUCTIONS) {
      throw new HttpError(400, `Instructions are ${text.length} characters; the limit is ${MAX_INSTRUCTIONS}. Shorten them and save again.`);
    }
    const file = instructionsFile();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    await writeFile(`${file}.tmp`, text);
    await rename(`${file}.tmp`, file);
    sendJson(res, 200, { text, isDefault: false });
    return true;
  }

  // Reset: no file, so the default applies again.
  if (method === "DELETE") {
    await rm(instructionsFile(), { force: true });
    sendJson(res, 200, await readInstructions());
    return true;
  }

  return false;
}
