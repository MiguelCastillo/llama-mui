// Which message a pin is for, said in a way that survives the server's copy of
// the session replacing the shown messages. Messages have no id of their own,
// and an index can shift (a message the page added before the server counted
// it, a system message, results grouped differently), so the pin keeps which
// chat message of the user's it is (counting only those) and its text, and
// finds the index again in whatever list is shown now. Pure, no DOM.
import type { ChatMessage } from "./api";

export interface PinKey {
  // How many of the user's chat messages come before it.
  ordinal: number;
  // Its text, as sent.
  text: string;
}

// A message the user wrote in the chat itself: not a side question, a plan
// step's message or a compaction request, which are drawn elsewhere or not
// pinned.
const isChatUser = (m: ChatMessage) => m.role === "user" && !m.aside && !m.planStep && !m.compaction;

/** The key for a message about to go at the end of `before` (or replace what follows it). */
export function pinKeyFor(before: ChatMessage[], text: string): PinKey {
  return { ordinal: before.filter(isChatUser).length, text };
}

/**
 * The index of the pinned message in `messages`, or null when it isn't there
 * yet (the page hasn't drawn it): the caller tries again on the next render.
 * First the user's chat message at that place with the same text; else the
 * last one at or after that place with the same text (the server counted the
 * ones before it differently); else the one at that place whatever its text.
 */
export function findPinned(messages: ChatMessage[], key: PinKey): number | null {
  const users: { index: number; ordinal: number; text: string }[] = [];
  messages.forEach((m, index) => {
    if (isChatUser(m)) users.push({ index, ordinal: users.length, text: m.content });
  });
  const atPlace = users.find((u) => u.ordinal === key.ordinal);
  if (atPlace && atPlace.text === key.text) return atPlace.index;
  const sameText = users.filter((u) => u.ordinal >= key.ordinal && u.text === key.text).pop();
  if (sameText) return sameText.index;
  return atPlace ? atPlace.index : null;
}
