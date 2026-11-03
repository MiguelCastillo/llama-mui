import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, forgetRevisions, getSession, renameSession, saveSession, type Session, type SessionSummary } from "../api";
import { removeRow, upsertRow, watchSessionList } from "../sessionRows";

const session = (id: string): Session => ({ id, title: "T", model: "m", messages: [], contextStart: 0, attachments: [], usage: null, failed: null, plan: null });
const row = (id: string, updatedAt: number): SessionSummary => ({ id, title: id, updatedAt });

// Answers each fetch with the next reply and keeps what was sent.
function serve(...replies: { status?: number; body: unknown }[]) {
  const sent: { method: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push({ method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = replies.shift()!;
      const status = r.status ?? 200;
      return { ok: status < 400, status, statusText: "", json: async () => r.body } as Response;
    }),
  );
  return sent;
}

beforeEach(() => forgetRevisions());
afterEach(() => vi.unstubAllGlobals());

describe("saveSession and the revision", () => {
  it("sends the revision it loaded, and the one the last save answered with", async () => {
    const sent = serve(
      { body: { ...session("a"), revision: 4 } },
      { body: { ...row("a", 1), revision: 5 } },
      { body: { ...row("a", 2), revision: 6 } },
    );
    await getSession("a");
    await saveSession(session("a"));
    await saveSession(session("a"));
    expect(sent.map((s) => s.body?.revision)).toEqual([undefined, 4, 5]);
  });

  it("sends none for a session it never loaded, as the first save of a new one", async () => {
    const sent = serve({ body: { ...row("new", 1), revision: 1 } }, { body: { ...row("new", 2), revision: 2 } });
    await saveSession(session("new"));
    await saveSession(session("new"));
    expect(sent.map((s) => s.body.revision)).toEqual([undefined, 1]);
  });

  it("keeps the revisions of different sessions apart", async () => {
    const sent = serve({ body: { ...session("a"), revision: 2 } }, { body: { ...session("b"), revision: 9 } }, { body: { ...row("a", 1), revision: 3 } });
    await getSession("a");
    await getSession("b");
    await saveSession(session("a"));
    expect(sent[2].body.revision).toBe(2);
  });

  it("replaces a revision the session object carries with the one the page loaded", async () => {
    const sent = serve({ body: { ...session("a"), revision: 7 } }, { body: { ...row("a", 1), revision: 8 } });
    await getSession("a");
    await saveSession({ ...session("a"), revision: 1 });
    expect(sent[1].body.revision).toBe(7);
  });

  it("throws an ApiError that says why a 409 was refused, and keeps its revision for the next try", async () => {
    serve(
      { body: { ...session("a"), revision: 2 } },
      { status: 409, body: { error: "This session changed somewhere else since this page loaded it.", reason: "stale revision", revision: 5 } },
    );
    await getSession("a");
    const err = await saveSession(session("a")).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.data).toMatchObject({ reason: "stale revision", revision: 5 });
    expect(err.message).toMatch(/changed somewhere else/);
    // Reloading is what brings the page up to date, not the error.
    const sent = serve({ body: { ...session("a"), revision: 5 } }, { body: { ...row("a", 3), revision: 6 } });
    await getSession("a");
    await saveSession(session("a"));
    expect(sent[1].body.revision).toBe(5);
  });

  it("follows a rename only when it was the very next write", async () => {
    const sent = serve(
      { body: { ...session("a"), revision: 2 } },
      { body: { ...row("a", 1), revision: 3 } }, // the rename: 2 -> 3, nothing in between
      { body: { ...row("a", 2), revision: 4 } },
      { body: { ...row("a", 3), revision: 9 } }, // a rename after other writes
      { status: 409, body: { error: "x", reason: "stale revision", revision: 9 } },
    );
    await getSession("a");
    await renameSession("a", { userName: "Mine" });
    await saveSession(session("a"));
    await renameSession("a", { userName: "Again" });
    await saveSession(session("a")).catch(() => {});
    expect(sent.filter((s) => s.method === "PUT").map((s) => s.body.revision)).toEqual([3, 4]);
  });
});

describe("the sessions list", () => {
  it("puts a saved row in its place, replacing the old one, and drops a deleted one", () => {
    const rows = [row("c", 30), row("b", 20), row("a", 10)];
    expect(upsertRow(rows, row("a", 40)).map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(upsertRow(rows, { ...row("b", 20), title: "Renamed" }).map((r) => r.title)).toEqual(["c", "Renamed", "a"]);
    expect(upsertRow(rows, row("d", 25)).map((r) => r.id)).toEqual(["c", "d", "b", "a"]);
    expect(removeRow(rows, "b").map((r) => r.id)).toEqual(["c", "a"]);
    expect(rows).toHaveLength(3); // the old list isn't changed
  });

  it("opens the events stream, passes on saves and deletes, and asks for a re-read only after a reconnect", () => {
    const handlers: Record<string, (e: any) => void> = {};
    const close = vi.fn();
    class FakeSource {
      constructor(public url: string) {
        sources.push(this);
      }
      addEventListener(type: string, fn: (e: any) => void) {
        handlers[type] = fn;
      }
      close = close;
    }
    const sources: FakeSource[] = [];
    vi.stubGlobal("EventSource", FakeSource);
    const seen = { saved: [] as string[], removed: [] as string[], reconnected: 0 };
    const threads: unknown[] = [];
    const stop = watchSessionList({
      saved: (r) => seen.saved.push(r.id),
      removed: (id) => seen.removed.push(id),
      thread: (e) => threads.push(e),
      reconnected: () => void seen.reconnected++,
    });
    expect(sources[0].url).toBe("/api/events");
    handlers.snapshot({ data: "{}" });
    expect(seen.reconnected).toBe(0); // the first open is not a reconnect
    handlers.saved({ data: JSON.stringify({ id: "a", summary: row("a", 1), revision: 2 }) });
    handlers.saved({ data: "not json" });
    handlers.removed({ data: JSON.stringify({ id: "b" }) });
    handlers.thread({ data: JSON.stringify({ id: "p", sessionId: "kid", status: "done", report: null, revision: 3 }) });
    handlers.thread({ data: JSON.stringify({ id: "p" }) }); // not a thread event
    handlers.snapshot({ data: "{}" });
    expect(seen).toEqual({ saved: ["a"], removed: ["b"], reconnected: 1 });
    expect(threads).toEqual([{ id: "p", sessionId: "kid", status: "done", report: null, revision: 3 }]);
    stop();
    expect(close).toHaveBeenCalled();
  });

  it("does nothing where there is no EventSource", () => {
    vi.stubGlobal("EventSource", undefined);
    expect(() => watchSessionList({ saved: () => {}, removed: () => {}, reconnected: () => {} })()).not.toThrow();
  });
});
