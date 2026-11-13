// Routes for personas (see personas.ts): the list the chat picker and Settings →
// Agent show, and the persona a new chat starts with.

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { resolveDefaultPersona } from "./personaChoice.ts";
import { loadPersonas, personasDir } from "./personas.ts";
import { load, save } from "./store.ts";

export { resolveDefaultPersona };

// Handles /api/personas; returns false for anything else.
export async function personaRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "personas") return false;

  if (parts.length === 1 && method === "GET") {
    const { personas, problems } = await loadPersonas();
    const def = await resolveDefaultPersona((await load()).defaultPersona, personas.map((p) => p.name));
    sendJson(res, 200, {
      personas: personas.map((p) => ({ name: p.name, description: p.description, tools: p.tools })),
      folder: personasDir(),
      problems: def.problem ? [...problems, def.problem] : problems,
      defaultPersona: def.name,
    });
    return true;
  }

  // Choose the default: { name }. Only a persona that exists can be chosen.
  if (parts.length === 2 && parts[1] === "default" && method === "PUT") {
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const { personas } = await loadPersonas();
    const found = personas.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new HttpError(400, `There is no persona named "${name}"`);
    const store = await load();
    store.defaultPersona = found.name;
    await save(store);
    sendJson(res, 200, { defaultPersona: found.name });
    return true;
  }

  return false;
}
