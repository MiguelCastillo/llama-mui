// What is in the message box: the text typed and the images added, not sent
// yet. It is a small store, owned by the chat and shared with the box, instead
// of state in either:
// - Typing redraws only what reads it: the box itself, and the Edit buttons on
//   screen, which follow only whether it is empty. The chat and its messages
//   aren't drawn again (in a long chat that took ~100 ms a keystroke).
// - The chat puts text in the box (Edit, the up arrow, a queued message taken
//   back) by writing it here; the box focuses itself when that happens.
// - Every change of the text is kept as the chat's draft (drafts.ts), so a
//   refresh brings it back, whoever made the change.

import { loadDraft, saveDraft } from "./drafts";

// An image added to the box: the file, ready to upload, and its preview's
// object URL (revoked once it is no longer shown).
export type PendingImage = { blob: Blob; preview: string; name: string };

export type BoxContent = { text: string; images: PendingImage[] };

export type MessageBox = {
  // What is in the box now. The same object until something changes, so it
  // can be read with useSyncExternalStore.
  get: () => BoxContent;
  // Nothing typed (spaces don't count) and no images: what Edit needs.
  isEmpty: () => boolean;
  // The chat whose draft the box holds.
  sessionId: () => string;
  // Shows chat `id`'s saved draft. The images stay, as they did before.
  show: (id: string) => void;
  // Replaces the text and keeps it as the draft of the chat shown.
  setText: (text: string) => void;
  // The same for chat `id`, which may no longer be shown (a send that ends
  // after another chat was opened): then only its draft is changed.
  setTextFor: (id: string, text: string) => void;
  setImages: (images: PendingImage[]) => void;
  // Puts text in the box for the user to change and send, adds `images`, and
  // asks the box to take focus.
  fill: (text: string, images?: PendingImage[]) => void;
  // Calls `listener` whenever fill is called (the box focuses itself).
  onFill: (listener: () => void) => () => void;
  // Calls `listener` on each change; the returned function stops it.
  subscribe: (listener: () => void) => () => void;
};

export type Drafts = { load: (id: string) => string; save: (id: string, text: string) => void };

export function createMessageBox(sessionId: string, drafts: Drafts = { load: loadDraft, save: saveDraft }): MessageBox {
  let shown = sessionId;
  let content: BoxContent = { text: drafts.load(sessionId), images: [] };
  const listeners = new Set<() => void>();
  const fillListeners = new Set<() => void>();
  const change = (next: Partial<BoxContent>) => {
    content = { ...content, ...next };
    listeners.forEach((l) => l());
  };
  const setTextFor = (id: string, text: string) => {
    drafts.save(id, text);
    if (id === shown && text !== content.text) change({ text });
  };
  const listen = (set: Set<() => void>) => (listener: () => void) => {
    set.add(listener);
    return () => void set.delete(listener);
  };
  return {
    get: () => content,
    isEmpty: () => content.text.trim() === "" && content.images.length === 0,
    sessionId: () => shown,
    show: (id) => {
      if (id === shown) return;
      shown = id;
      change({ text: drafts.load(id) });
    },
    setText: (text) => setTextFor(shown, text),
    setTextFor,
    setImages: (images) => change({ images }),
    fill: (text, images) => {
      setTextFor(shown, text);
      if (images?.length) change({ images: [...content.images, ...images] });
      fillListeners.forEach((l) => l());
    },
    onFill: listen(fillListeners),
    subscribe: listen(listeners),
  };
}
