// Skills: a folder of instructions the model can open when a task matches. Each
// skill is a folder holding a SKILL.md, inside a source folder:
//
//   ~/.llama-mui/skills/<skill-name>/SKILL.md
//
// SKILL.md starts with a header between two lines of "---" (name and
// description), and the rest is the instructions. Fields the app doesn't know
// are ignored, so later versions can add some without breaking older files.
// The folder may hold other files for the instructions to point at.
//
//   ---
//   name: pdf-forms
//   description: Fill in and check PDF forms
//   ---
//   Instructions for the model...

import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePersonaFile } from "./personas.ts";
import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

export type Skill = {
  name: string;
  description: string;
  instructions: string;
  // The skill's own folder, so its other files can be read.
  dir: string;
};

// A plain message about one skill file, for the user to read.
export type SkillProblem = { file: string; message: string };

export type SkillSource = { name: string; dir: string };

// Where skills are looked for, in order: when two skills share a name, the
// earlier source wins. To add a place later, add an entry here. Tests point
// LLAMA_MUI_SKILLS_DIR at a folder of their own, which replaces the list, so
// they never read the real one.
export function skillSources(): SkillSource[] {
  const override = process.env.LLAMA_MUI_SKILLS_DIR;
  if (override) return [{ name: "test", dir: override }];
  return [{ name: "user", dir: path.join(os.homedir(), ".llama-mui", "skills") }];
}

// The part of the system prompt that tells the model what skills exist: one
// line per skill, name and description only (the instructions are opened on
// demand with load_skill). Empty when there are no skills, so the prompt is
// exactly what it was before skills.
export function skillsPromptText(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  return [
    "Skills available. When the task matches one, open it with the load_skill tool before you start:",
    ...skills.map((s) => `- ${oneLine(s.name)}: ${oneLine(s.description)}`),
  ].join("\n");
}

const loadSkill: ToolSpec = {
  name: "load_skill",
  group: "skills",
  label: "Open skills",
  summary: "Read a skill's instructions.",
  definition: fn(
    "load_skill",
    "Open one of the available skills (listed in the system prompt) and return its instructions and its folder.",
    {
      type: "object",
      properties: { name: { type: "string", description: "The skill's name, as listed." } },
      required: ["name"],
    },
  ),
  async run(_ctx, args) {
    const name = String(args.name ?? "").trim();
    const { skills } = await loadSkills();
    const skill = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!skill) {
      const names = skills.map((s) => s.name).join(", ");
      throw new ToolError(`there is no skill named "${name}". ${names ? `Available skills: ${names}.` : "No skills are available."}`);
    }
    return `${skill.instructions}\n\nSkill folder: ${skill.dir}\n(Files the instructions mention are in this folder; read them with read_file.)`;
  },
};

export const SKILL_TOOLS = [loadSkill];

export type LoadedSkills = { skills: Skill[]; problems: SkillProblem[] };

// All the skills in the sources. A folder without a usable SKILL.md is skipped
// with a plain message (a folder with no SKILL.md at all is just not a skill);
// so is a name an earlier skill already has. A missing source is no skills.
export async function loadSkills(sources: SkillSource[] = skillSources()): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];
  const seen = new Map<string, string>();
  for (const source of sources) {
    let folders: string[];
    try {
      folders = (await readdir(source.dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
    } catch {
      continue;
    }
    for (const folder of folders) {
      const dir = path.join(source.dir, folder);
      const file = path.join(folder, "SKILL.md");
      let text: string;
      try {
        text = await readFile(path.join(dir, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
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
      const description = parsed.fields.get("description") ?? "";
      if (!description) {
        problems.push({ file, message: `${file} has no description in its header, so it was skipped.` });
        continue;
      }
      const earlier = seen.get(name.toLowerCase());
      if (earlier) {
        problems.push({ file, message: `${file} uses the name "${name}", which ${earlier} already has, so it was skipped.` });
        continue;
      }
      seen.set(name.toLowerCase(), file);
      skills.push({ name, description, instructions: parsed.body, dir });
    }
  }
  return { skills, problems };
}
