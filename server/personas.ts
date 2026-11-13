// Personas: how the agent is told to work, one markdown file each in the
// app's `personas` folder (at the project's top level), shipped with the app.
// Builder.md is the default; a new persona is a new file there. A file starts
// with a header between two lines of "---" (name, description and an optional
// tools list), and the rest of the file is the instructions. Fields the app
// doesn't know are ignored, so later versions can add some without breaking
// older files. No tools field means every tool; otherwise it is a
// comma-separated list of tool names (names only for now).
//
//   ---
//   name: Reviewer
//   description: Reads the code and says what's wrong
//   tools: read_file, grep
//   ---
//   Instructions for the model...

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Persona = {
  name: string;
  description: string;
  instructions: string;
  // The file's name in the personas folder.
  file: string;
  // The tools this persona may use, by name. Absent: no limit (every tool).
  tools?: string[];
};

// A plain message about one file, for the user to read.
export type PersonaProblem = { file: string; message: string };

export type PersonaFile = { file: string; text: string };

export const BUILDER_NAME = "Builder";

// The app's personas folder: `personas/` next to `server/`. Tests point
// LLAMA_MUI_PERSONAS_DIR at a folder of their own, so they never write here.
export const appPersonasDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "personas");
export const personasDir = () => process.env.LLAMA_MUI_PERSONAS_DIR || appPersonasDir();

// The .md files in a folder, by name. A missing or unreadable folder is no files.
async function filesIn(dir: string): Promise<PersonaFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md") && !n.startsWith(".")).sort();
  } catch {
    return [];
  }
  const out: PersonaFile[] = [];
  for (const file of names) {
    try {
      out.push({ file, text: await readFile(path.join(dir, file), "utf8") });
    } catch {
      // A file that can't be read is skipped; a folder named like a file, say.
    }
  }
  return out;
}

type Parsed = { fields: Map<string, string>; body: string } | null;

// The header is "key: value" lines between two "---" lines at the very top.
// Null when there is no header.
export function parsePersonaFile(text: string): Parsed {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) fields.set(m[1].toLowerCase(), m[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return { fields, body: lines.slice(end + 1).join("\n").trim() };
}

// The app's real tool names. Read when first needed, since the tools module
// itself imports this one.
async function knownTools(): Promise<Set<string>> {
  return new Set((await import("./tools.ts")).allToolNames());
}

export type LoadedPersonas = { personas: Persona[]; problems: PersonaProblem[] };

// All the personas in the folder (the app's unless a test passes another). A
// file with no header, no name or a name already taken is skipped, with a
// plain message; so is a missing Builder, since new chats start with it.
export async function loadPersonas(dir: string = personasDir()): Promise<LoadedPersonas> {
  const personas: Persona[] = [];
  const problems: PersonaProblem[] = [];
  const seen = new Map<string, Persona>();
  for (const { file, text } of await filesIn(dir)) {
    const parsed = parsePersonaFile(text);
    if (!parsed) {
      problems.push({ file, message: `${file} has no header (a block between two "---" lines at the top), so it was skipped.` });
      continue;
    }
    const name = parsed.fields.get("name") ?? "";
    if (!name) {
      problems.push({ file, message: `${file} has no name in its header, so it was skipped.` });
      continue;
    }
    const earlier = seen.get(name.toLowerCase());
    if (earlier) {
      problems.push({ file, message: `${file} uses the name "${name}", which ${earlier.file} already has, so it was skipped.` });
      continue;
    }
    const persona: Persona = { name, description: parsed.fields.get("description") ?? "", instructions: parsed.body, file };
    const toolsField = parsed.fields.get("tools");
    if (toolsField !== undefined) {
      const known = await knownTools();
      const listed = [...new Set(toolsField.split(",").map((t) => t.trim()).filter(Boolean))];
      const unknown = listed.filter((t) => !known.has(t));
      for (const t of unknown) {
        problems.push({ file, message: `${file} lists a tool called "${t}", which the app doesn't have, so it was left out.` });
      }
      persona.tools = listed.filter((t) => known.has(t));
    }
    seen.set(name.toLowerCase(), persona);
    personas.push(persona);
  }
  if (!seen.has(BUILDER_NAME.toLowerCase())) {
    problems.push({
      file: `${BUILDER_NAME}.md`,
      message: `There's no usable ${BUILDER_NAME}.md in the app's personas folder, so chats without a persona get no persona instructions.`,
    });
  }
  return { personas, problems };
}

// The persona's text for the system prompt: its instructions, then, when it has
// a tools list, one plain line naming the tools it may use, so a refused call
// isn't a surprise. No list adds nothing (Builder's text is its file's).
export function personaPromptText(persona: Persona): string {
  if (!persona.tools) return persona.instructions;
  const names = [...persona.tools, "add_idea", "add_action_item"].filter((t, i, all) => all.indexOf(t) === i);
  const line = `In this chat you may use only these tools: ${names.join(", ")}. Any other tool call is refused.`;
  return persona.instructions ? `${persona.instructions}\n${line}` : line;
}

// What a chat gets when the persona it needs isn't there: no instructions,
// only the fixed start and the baseline every chat has.
export const noPersona = (name: string): Persona => ({ name, description: "", instructions: "", file: "" });
