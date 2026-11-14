// The message that asks the model for a compaction summary (see src/compact.ts):
// the whole text of `prompts/compaction-instructions.md`, a file of its own so
// the wording can be read and changed without touching code. It sits at the
// project's top level next to `server/`, like `personas/`, and ships with the app.
//
// Read each time a compaction runs, so a change to the file applies to the next
// compaction without a restart. The file is only the message: nothing in it is
// for people, because the model reads all of it. Surrounding blank lines are
// trimmed.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const compactInstructionFile = () =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "compaction-instructions.md");

// The instruction, or an Error whose message says in plain words which file
// couldn't be read and why. There is no built-in copy: a second wording would
// drift from the file.
export async function compactInstruction(file = compactInstructionFile()): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e: any) {
    throw new Error(`The compaction instructions couldn't be read from ${file}: ${e?.message ?? e}`);
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`The compaction instructions file is empty: ${file}`);
  return trimmed;
}
