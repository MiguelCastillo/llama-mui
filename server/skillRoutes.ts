// Route for skills (see skills.ts): the list Settings → Agent shows. Read-only;
// the skills are folders the user keeps by hand.

import { type Route, sendJson } from "./http.ts";
import { loadSkills, skillSources } from "./skills.ts";

// Handles /api/skills; returns false for anything else.
export async function skillRoutes({ res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "skills" || parts.length !== 1 || method !== "GET") return false;
  const { skills, problems } = await loadSkills();
  sendJson(res, 200, {
    // Name and description only: the instructions are for the model.
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
    problems,
    // The folders skills are looked for in, first (the one to use) first.
    folder: skillSources()[0]?.dir ?? "",
    folders: skillSources().map((s) => s.dir),
  });
  return true;
}
