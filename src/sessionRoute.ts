// "#/session/<id>": an address that opens one saved chat. The open chat is
// remembered per browser (SESSION_KEY, read when Chat loads), so a browser with
// nothing remembered, like the fresh Chrome inspect_page starts every time,
// always opens an empty chat. The route sets what Chat reads before it loads,
// then the address goes back to plain: it is a way in, not a place the page
// stays, so a reload or a click on another chat isn't pulled back to this one.

// Which saved chat is open, so a reload reopens it.
export const SESSION_KEY = "llama-mui:sessionId";

// The server's rule for an id (sessionFolder in server/sessionFile.ts): ids
// become folder names, so only plain ones count.
const SESSION_ID = /^[a-z0-9-]{1,64}$/;

export const sessionHash = (id: string) => `#/session/${id}`;

// The id the address names, or null for any other address or a bad id.
export function sessionFromHash(hash: string): string | null {
  const match = /^#\/session\/([^/?#]+)$/.exec(hash);
  return match && SESSION_ID.test(match[1]) ? match[1] : null;
}

// Makes the chat the address names the open one and clears the address.
// Returns whether it did; storage that can't be written leaves the address as
// it was, so nothing looks opened that isn't.
export function takeSessionRoute(hash: string, storage: Pick<Storage, "setItem">, clearHash: () => void): boolean {
  const id = sessionFromHash(hash);
  if (!id) return false;
  try {
    storage.setItem(SESSION_KEY, id);
  } catch {
    return false;
  }
  clearHash();
  return true;
}
