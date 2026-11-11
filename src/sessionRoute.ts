// "#/session/<id>": the address of one saved chat. The address stays: it names
// the chat that is open, so each chat you switch to is a real entry in the
// browser's history and the back button returns to the last one. The open chat
// is also remembered per browser (SESSION_KEY, read when Chat loads), so a
// reload of a plain address reopens it; a browser with nothing remembered, like
// the fresh Chrome inspect_page starts every time, opens an empty chat.

// Which saved chat is open, so a reload reopens it.
export const SESSION_KEY = "llama-mui:sessionId";

// The server's rule for an id (sessionFolder in server/sessionFile.ts): ids
// become folder names, so only plain ones count.
const SESSION_ID = /^[a-z0-9-]{1,64}$/;

export const sessionHash = (id: string) => `#/session/${id}`;

// Makes the address name chat `id`. "push" adds a history entry (a chat the
// user switched to); "replace" rewrites the current one (first load, going
// back or forward, a deleted chat's stand-in). Nothing happens when the address
// already names it. Neither call fires a hashchange.
export function setSessionAddress(id: string, mode: "push" | "replace") {
  const hash = sessionHash(id);
  if (location.hash === hash) return;
  try {
    if (mode === "push") history.pushState(null, "", hash);
    else history.replaceState(null, "", hash);
  } catch {
    // The address can't be changed; the chat still opens.
  }
}

// The address of the chat that is open (the one remembered for this browser),
// or "" when none is remembered. Settings and the checklist go back to it.
export function openChatHash(): string {
  try {
    const id = localStorage.getItem(SESSION_KEY);
    return id && SESSION_ID.test(id) ? sessionHash(id) : "";
  } catch {
    return "";
  }
}

// The id the address names, or null for any other address or a bad id.
export function sessionFromHash(hash: string): string | null {
  const match = /^#\/session\/([^/?#]+)$/.exec(hash);
  return match && SESSION_ID.test(match[1]) ? match[1] : null;
}

// Reads the chat the address names and remembers it as the open one, so Chat's
// next load finds it. Returns the id, or null for any other address or a bad
// id. The address is left as it is. Storage that can't be written still
// returns the id: the address itself names the chat.
export function routeSession(hash: string, storage: Pick<Storage, "setItem">): string | null {
  const id = sessionFromHash(hash);
  if (!id) return null;
  try {
    storage.setItem(SESSION_KEY, id);
  } catch {
    // Not remembered; the address still says which chat.
  }
  return id;
}
