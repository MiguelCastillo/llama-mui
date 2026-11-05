// Text typed in the message box and not sent yet, kept in this browser per
// chat, so a refresh (or a phone that reloads the page) brings it back. It is
// removed when the message goes or the box is emptied. Only the newest few
// chats keep one, so abandoned new chats don't pile up.

const KEY = "llama-mui:drafts";
export const MAX_DRAFTS = 30;

type Drafts = Record<string, string>;

// The drafts after chat `id`'s becomes `text`: empty removes it, and the oldest
// go once there are more than `max`. Object keys keep their order, so the
// newest edit is moved to the end.
export function withDraft(drafts: Drafts, id: string, text: string, max = MAX_DRAFTS): Drafts {
  const { [id]: _old, ...rest } = drafts;
  const next = text ? { ...rest, [id]: text } : rest;
  const ids = Object.keys(next);
  return Object.fromEntries(ids.slice(Math.max(0, ids.length - max)).map((k) => [k, next[k]]));
}

function read(): Drafts {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export const loadDraft = (id: string): string => (typeof read()[id] === "string" ? read()[id] : "");

export function saveDraft(id: string, text: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(withDraft(read(), id, text)));
  } catch {
    // Not kept this time; typing still works.
  }
}
