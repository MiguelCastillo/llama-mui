// Which persona a chat works with: the one saved with the chat, else the default.
// Kept apart from the routes so the prompt (tools.ts) and the persona routes can
// both use it without importing each other.

import { BUILDER_NAME, type Persona, type PersonaProblem, noPersona } from "./personas.ts";

// The default persona's name as it will be used: the saved one if a persona of
// that name exists, otherwise Builder, with a plain message saying so.
export async function resolveDefaultPersona(
  saved: string | undefined,
  names: string[],
): Promise<{ name: string; problem: PersonaProblem | null }> {
  const wanted = (saved ?? "").trim() || BUILDER_NAME;
  const found = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
  if (found) return { name: found, problem: null };
  return {
    name: BUILDER_NAME,
    problem: {
      file: "settings",
      message: `The default persona "${wanted}" doesn't exist, so new chats start with ${BUILDER_NAME}.`,
    },
  };
}

const named = (personas: Persona[], name: string) => personas.find((p) => p.name.toLowerCase() === name.toLowerCase());

// The persona to use for a chat. `saved` is the name saved with the chat, or
// undefined when none was saved: then the default is used. A saved name that no
// longer exists falls back to Builder, and `note` says so in plain words for
// the chat update. The saved name itself is left alone, so the persona comes
// back if its file does. With no Builder either, the chat gets no persona text.
export async function personaForChat(
  saved: string | undefined,
  defaultName: string | undefined,
  personas: Persona[],
): Promise<{ persona: Persona; note: string | null }> {
  const builder = () => named(personas, BUILDER_NAME) ?? noPersona(BUILDER_NAME);
  if (saved) {
    const found = named(personas, saved);
    if (found) return { persona: found, note: null };
    return {
      persona: builder(),
      note: `The persona "${saved}" this chat started with doesn't exist any more, so the chat now works as ${BUILDER_NAME}.`,
    };
  }
  const def = await resolveDefaultPersona(defaultName, personas.map((p) => p.name));
  return { persona: named(personas, def.name) ?? builder(), note: null };
}
