// A chat's persona is saved as its name, fixed once the first message is sent:
// no mid-chat switching. These are the only places that decide whether it may
// change, so the picker, the runner and the server's save all follow the same
// rule. To work differently, start a new chat. (The persona's text is fixed
// separately, with the prompt, until Clear context: see Session.personaText.)

type Started = { messages?: unknown[]; promptDir?: string | null };

// The first message has been sent. Clear context empties what the model sees
// (and resets promptDir), but the messages are still there, so the rule holds.
export const personaIsFixed = (s: Started): boolean => (s.messages?.length ?? 0) > 0 || s.promptDir !== undefined;

// A name as saved: text with something in it, or nothing.
export const cleanPersona = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// The picker's choice. Refused (the session comes back unchanged) once the chat has started.
export function withChosenPersona<T extends Started & { persona?: string }>(s: T, name: string): T {
  return personaIsFixed(s) ? s : { ...s, persona: name };
}

// At the first reply: records the persona the prompt was built for when none was
// chosen. A persona already saved is never replaced.
export function withFrozenPersona<T extends { persona?: string }>(s: T, name: string | undefined): T {
  return s.persona !== undefined || !name ? s : { ...s, persona: name };
}

// The persona a save keeps. A chat that has started keeps the one on disk,
// whatever a page sends (a stale copy, say); one that hasn't takes what was sent.
export function personaToSave(old: (Started & { persona?: unknown }) | undefined, sent: unknown): string | undefined {
  return old && personaIsFixed(old) ? cleanPersona(old.persona) : cleanPersona(sent);
}
