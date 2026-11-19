// The project's own instructions: AGENTS.md in the chat's working directory,
// added to the system prompt (see toolsSystemPrompt). They are the project's
// principles, not the user's preferences (those are in rules.ts).
//
// Reads change nothing, so they use node:fs/promises directly (the audit
// wrappers in io/fs.ts cover changes only; see the file-access audit test).

import { readFile } from "node:fs/promises";
import path from "node:path";

// The recommended length lives in projectNote.ts (the page imports it too).
export { RECOMMENDED_PROJECT_INSTRUCTIONS } from "./projectNote.ts";

// The files read, in order; each that exists and has text would be loaded.
// Only AGENTS.md for now. Letting users choose more context files (another
// name such as CLAUDE.md, or several at once) attaches here later, as a list
// from a setting; nothing else is read on its own.
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md"];

export type ProjectInstructions = { file: string; text: string };

// The attachment point for trust: whether it is OK to load a project's file
// into the prompt. Today every folder is trusted ("always load"). A later
// layer (asking before loading a cloned project's file) replaces this body;
// the reader below already calls it and needs no other change.
export function trusted(_dir: string): boolean {
  return true;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null; // missing, a folder, unreadable: the same as no file
  }
}

// The project's instructions for a working directory, or null when there are
// none (no folder, no file, empty file, not trusted). Never throws. With one
// file in the list the first that has text is the answer; when the list grows
// to several, this is where they would be joined.
export async function readProjectInstructions(dir: string | undefined | null): Promise<ProjectInstructions | null> {
  try {
    if (typeof dir !== "string" || !dir.trim() || !path.isAbsolute(dir)) return null;
    if (!trusted(dir)) return null;
    for (const file of PROJECT_INSTRUCTION_FILES) {
      const text = ((await readText(path.join(dir, file))) ?? "").trim();
      if (text) return { file, text };
    }
    return null;
  } catch {
    return null;
  }
}
