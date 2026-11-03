// What changed between two copies of a session, small enough to send on every
// pause in a streaming reply. A page that holds the earlier copy applies it and
// has the later one; the chat is never sent whole, since a long one is
// megabytes and the reply changes only at its end.
//
//   fields    top-level fields whose value changed (new value in full), except messages
//   removed   top-level fields that are gone
//   messages  when the messages changed: `from`, the first index that differs,
//             `items`, every message from there on, and `length`, how many there
//             are now (so a shorter chat, after a Resend, cuts the old tail off)
//
// `revision` and `run` are the server's and travel in other events, so they
// are never part of a patch.

export interface SessionPatch {
  fields: Record<string, unknown>;
  removed: string[];
  messages?: { from: number; items: unknown[]; length: number };
}

const SERVER_FIELDS = new Set(["revision", "run"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// A copy that a later change to the original can't reach, without the server's fields.
export function copyForEvents(session: any): any {
  const copy = JSON.parse(JSON.stringify(session));
  for (const k of SERVER_FIELDS) delete copy[k];
  return copy;
}

// Null when nothing changed.
export function diffSession(prev: any, next: any): SessionPatch | null {
  const fields: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const key of Object.keys(next)) {
    if (key === "messages" || SERVER_FIELDS.has(key)) continue;
    if (!(key in prev) || !same(prev[key], next[key])) fields[key] = next[key];
  }
  for (const key of Object.keys(prev)) {
    if (key === "messages" || SERVER_FIELDS.has(key)) continue;
    if (!(key in next)) removed.push(key);
  }
  const patch: SessionPatch = { fields, removed };
  const a: unknown[] = Array.isArray(prev.messages) ? prev.messages : [];
  const b: unknown[] = Array.isArray(next.messages) ? next.messages : [];
  let from = 0;
  while (from < a.length && from < b.length && same(a[from], b[from])) from++;
  if (from !== a.length || from !== b.length) patch.messages = { from, items: b.slice(from), length: b.length };
  return Object.keys(fields).length === 0 && removed.length === 0 && !patch.messages ? null : patch;
}

// What a page does with a patch: the session as it is after.
export function applyPatch(session: any, patch: SessionPatch): any {
  const out = { ...session, ...patch.fields };
  for (const key of patch.removed) delete out[key];
  if (patch.messages) {
    const { from, items, length } = patch.messages;
    out.messages = [...(session.messages ?? []).slice(0, from), ...items].slice(0, length);
  }
  return out;
}
