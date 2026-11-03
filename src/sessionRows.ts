// Keeping the sessions list current from the server's events, and the stream
// that brings them. The list is newest first, as the server sends it.

import type { SessionSummary } from "./api";
import type { ThreadEvent } from "./planThread";

// Puts `row` in the list: replaces the row with its id, or adds it, and keeps
// the server's order (newest first, ties by id). Another window's save or a
// run's save lands in the right place without a reload of the whole list.
export function upsertRow(rows: SessionSummary[], row: SessionSummary): SessionSummary[] {
  return [...rows.filter((r) => r.id !== row.id), row].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export const removeRow = (rows: SessionSummary[], id: string): SessionSummary[] => rows.filter((r) => r.id !== id);

export interface ListWatch {
  // A session was saved or renamed: its new row.
  saved: (row: SessionSummary) => void;
  removed: (id: string) => void;
  // A thread's run ended and its parent's note changed (see server/threadReport.ts):
  // `id` is the parent, `revision` the one its file now has.
  thread?: (e: { id: string; revision: number } & ThreadEvent) => void;
  // The connection came back after a drop. Events in between were missed, so
  // read the list again.
  reconnected: () => void;
}

// Opens the server's event stream for the whole list (GET /api/events) and
// reports saves, deletes and threads reporting back. The browser reopens a dropped stream by itself; every
// open starts with a `snapshot`, and any after the first means a reconnect.
// Returns what closes it. Without EventSource (a test, an old browser) it does
// nothing, and the list is only as current as the last time it was read.
export function watchSessionList(handlers: ListWatch): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource("/api/events");
  let opened = false;
  const read = (e: Event) => {
    try {
      return JSON.parse((e as MessageEvent).data);
    } catch {
      return null;
    }
  };
  source.addEventListener("snapshot", () => {
    if (opened) handlers.reconnected();
    opened = true;
  });
  source.addEventListener("saved", (e) => {
    const data = read(e);
    if (data?.summary) handlers.saved(data.summary);
  });
  source.addEventListener("removed", (e) => {
    const data = read(e);
    if (typeof data?.id === "string") handlers.removed(data.id);
  });
  source.addEventListener("thread", (e) => {
    const data = read(e);
    if (typeof data?.id === "string" && typeof data.sessionId === "string" && data.status) handlers.thread?.(data);
  });
  return () => source.close();
}
