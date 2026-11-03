import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetRevisions, type Session } from "../api";
import {
  START_WAIT_MS,
  allViews,
  dismiss,
  getView,
  needsYou,
  pause,
  pauseControl,
  resetRunClient,
  resume,
  startRun,
  stop,
  subscribe,
  subscribeAll,
  type RunnerEvent,
  type RunnerView,
} from "../runClient";

// A stand-in for the browser's EventSource that the test feeds by hand.
class FakeSource {
  static all: FakeSource[] = [];
  closed = false;
  private handlers = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.handlers.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}
const opened = (url: string) => FakeSource.all.filter((s) => s.url === url);
// The app-wide stream, opened by a listener if the test hasn't opened it yet.
const global = () => {
  if (!opened("/api/events").length) subscribeAll(() => {});
  return opened("/api/events")[0];
};
const watch = (id: string) => opened(`/api/sessions/${id}/events`).at(-1)!;

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  title: "T",
  model: "m",
  messages: [],
  contextStart: 0,
  attachments: [],
  usage: null,
  failed: null,
  plan: [
    { id: "s1", text: "One", status: "pending" },
    { id: "s2", text: "Two", status: "pending" },
  ],
  ...extra,
});

const run = (extra: object = {}) => ({ status: "running", startedAt: 1000, ...extra });

// Answers each request; keeps what was sent.
type Reply = { status?: number; body: unknown };
const requests: { method: string; path: string; body: any }[] = [];
let replies: (method: string, path: string) => Reply;
function serve(handler: (method: string, path: string) => Reply) {
  replies = handler;
}
const commands = () => requests.filter((r) => r.path.includes("/commands/"));

beforeEach(() => {
  FakeSource.all = [];
  requests.length = 0;
  forgetRevisions();
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      requests.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = replies(method, path);
      const status = r.status ?? 200;
      return { ok: status < 400, status, statusText: "", json: async () => r.body } as Response;
    }),
  );
  serve((method, path) => (method === "GET" ? { body: { ...session("a"), revision: 9 } } : { body: { ok: true, revision: 9 } }));
});
afterEach(() => {
  resetRunClient();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the run list", () => {
  it("shows the runs the server lists, without their sessions, and tells subscribeAll", async () => {
    const events: RunnerEvent[] = [];
    subscribeAll((e) => events.push(e));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    const view = getView("a")!;
    expect(view).toMatchObject({ sessionId: "a", status: "running", session: null, ask: null, startedAt: 1000 });
    expect(allViews().map((v) => v.sessionId)).toEqual(["a"]);
    expect(events.map((e) => [e.id, e.kind])).toEqual([["a", "status"]]);
  });

  it("opens one stream for the whole app, however many listen", () => {
    subscribeAll(() => {});
    subscribeAll(() => {});
    subscribe("a", () => {});
    expect(opened("/api/events")).toHaveLength(1);
  });

  it("follows a status change, and tells subscribeAll only about status and ask", () => {
    const events: RunnerEvent[] = [];
    subscribeAll((e) => events.push(e));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    global().emit("status", { id: "a", run: run({ streaming: true }) });
    global().emit("status", { id: "a", run: run({ status: "pausing", streaming: true }) });
    expect(getView("a")).toMatchObject({ status: "pausing", streaming: true });
    expect(events.map((e) => e.kind)).toEqual(["status", "status"]);
  });

  it("a run the list no longer has is over (after a reconnect's snapshot)", async () => {
    global().emit("snapshot", { runs: [{ id: "a", run: run() }, { id: "b", run: run() }] });
    const seen: RunnerEvent[] = [];
    subscribeAll((e) => seen.push(e));
    serve(() => ({ body: { ...session("b"), revision: 3 } }));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    await flush();
    expect(getView("b")).toBeUndefined();
    expect(getView("a")).toBeDefined();
    expect(seen.map((e) => [e.id, e.view?.status])).toEqual([["b", "stopped"]]);
  });
});

describe("one session's stream", () => {
  it("opens only for a session with a run that someone listens to, and closes with the last listener", () => {
    const off = subscribe("a", () => {});
    expect(opened("/api/sessions/a/events")).toHaveLength(0);
    global().emit("snapshot", { runs: [{ id: "a", run: run() }, { id: "b", run: run() }] });
    expect(opened("/api/sessions/a/events")).toHaveLength(1);
    expect(opened("/api/sessions/b/events")).toHaveLength(0);
    const second = subscribe("a", () => {});
    expect(opened("/api/sessions/a/events")).toHaveLength(1);
    off();
    expect(watch("a").closed).toBe(false);
    second();
    expect(watch("a").closed).toBe(true);
  });

  it("shows the snapshot's session and then each patch, as new objects", () => {
    const views: RunnerView[] = [];
    subscribe("a", (v) => views.push(v));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    const first = session("a", { messages: [{ role: "user", content: "hi" }] });
    watch("a").emit("snapshot", { id: "a", session: first, revision: 4, run: run() });
    expect(views.at(-1)!.session).toEqual(first);
    watch("a").emit("session", {
      id: "a",
      patch: {
        fields: { title: "Renamed" },
        removed: [],
        messages: { from: 1, items: [{ role: "assistant", content: "ok" }], length: 2 },
      },
    });
    const last = views.at(-1)!;
    expect(last.session?.title).toBe("Renamed");
    expect(last.session?.messages.map((m) => m.content)).toEqual(["hi", "ok"]);
    expect(last).not.toBe(views.at(-2));
    // The snapshot's own copy was not changed.
    expect(first.title).toBe("T");
  });

  it("a snapshot after a reconnect replaces what was there", () => {
    const views: RunnerView[] = [];
    subscribe("a", (v) => views.push(v));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    watch("a").emit("snapshot", { id: "a", session: session("a", { title: "old" }), revision: 1, run: run() });
    watch("a").emit("snapshot", { id: "a", session: session("a", { title: "new" }), revision: 2, run: run({ status: "paused" }) });
    expect(views.at(-1)).toMatchObject({ status: "paused" });
    expect(views.at(-1)!.session?.title).toBe("new");
  });

  it("each listener hears only its own session", () => {
    const a: RunnerView[] = [];
    const b: RunnerView[] = [];
    subscribe("a", (v) => a.push(v));
    subscribe("b", (v) => b.push(v));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }, { id: "b", run: run() }] });
    global().emit("status", { id: "b", run: run({ status: "paused" }) });
    expect(a.every((v) => v.sessionId === "a")).toBe(true);
    expect(b.map((v) => v.status)).toEqual(["running", "paused"]);
  });
});

describe("when the run ends", () => {
  const ended = async (id = "a", error?: string) => {
    global().emit("status", { id, run: null, ...(error ? { error } : {}) });
    await flush();
  };

  it("reads the session from the server and hands it over as the last view", async () => {
    const views: RunnerView[] = [];
    subscribe("a", (v) => views.push(v));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    serve(() => ({ body: { ...session("a", { title: "Final" }), revision: 12 } }));
    await ended("a", "The model stopped answering.");
    const last = views.at(-1)!;
    expect(last).toMatchObject({ status: "stopped", error: "The model stopped answering.", ask: null });
    expect(last.session?.title).toBe("Final");
    expect(requests.filter((r) => r.method === "GET").map((r) => r.path)).toEqual(["/api/sessions/a"]);
    expect(getView("a")).toBeUndefined();
    expect(opened("/api/sessions/a/events")[0].closed).toBe(true);
  });

  it("the page's next save carries the revision it read at the end", async () => {
    const { saveSession } = await import("../api");
    subscribe("a", () => {});
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    serve(() => ({ body: { ...session("a"), revision: 12 } }));
    await ended();
    serve(() => ({ body: { id: "a", title: "T", updatedAt: 1, revision: 13 } }));
    await saveSession(session("a"));
    expect(requests.at(-1)!.body.revision).toBe(12);
  });

  it("is told once, whichever stream says so first", async () => {
    const views: RunnerView[] = [];
    subscribe("a", (v) => views.push(v));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    const per = watch("a");
    per.emit("status", { id: "a", run: null });
    global().emit("status", { id: "a", run: null });
    await flush();
    expect(views.filter((v) => v.status === "stopped")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "GET")).toHaveLength(1);
  });

  it("keeps a run that ended unseen and left a question, until the session is opened", async () => {
    const seen: RunnerEvent[] = [];
    subscribeAll((e) => seen.push(e));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    serve(() => ({
      body: { ...session("a", { plan: [{ id: "s1", text: "One", status: "waiting", note: "Which branch?" }] }), revision: 2 },
    }));
    await ended();
    expect(needsYou(getView("a"))).toBe(true);
    expect(allViews().map((v) => v.sessionId)).toEqual(["a"]);
    dismiss("a");
    expect(getView("a")).toBeUndefined();
    expect(seen.map((e) => e.kind)).toEqual(["status", "status", "dismissed"]);
  });

  it("keeps nothing of a run that ended with every step done", async () => {
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    serve(() => ({ body: { ...session("a", { plan: [{ id: "s1", text: "One", status: "done" }] }), revision: 2 } }));
    await ended();
    expect(getView("a")).toBeUndefined();
    expect(allViews()).toEqual([]);
  });

  it("forgets a session that was deleted", async () => {
    const seen: RunnerEvent[] = [];
    subscribeAll((e) => seen.push(e));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    global().emit("removed", { id: "a" });
    expect(getView("a")).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ id: "a", kind: "dismissed", view: null });
  });

  it("a session that is gone from the server when read is dropped, not shown", async () => {
    const seen: RunnerEvent[] = [];
    subscribeAll((e) => seen.push(e));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    serve(() => ({ status: 404, body: { error: "No such session" } }));
    await ended();
    expect(seen.at(-1)).toMatchObject({ kind: "dismissed" });
  });
});

describe("asks", () => {
  const ask = (id: string, kind: "access" | "location" | "approval", details: object) => ({ id, kind, details });

  it("turns the stored ask into the shape the prompts take, the same object while it is the same ask", () => {
    global().emit("snapshot", { runs: [{ id: "a", run: run({ status: "waiting", ask: ask("q1", "access", { path: "/x", kind: "folder" }) }) }] });
    const first = getView("a")!;
    expect(first.ask!.ask).toEqual({ needsAccess: { path: "/x", kind: "folder" } });
    expect(needsYou(first)).toBe(true);
    global().emit("status", { id: "a", run: run({ status: "waiting", streaming: true, ask: ask("q1", "access", { path: "/x", kind: "folder" }) }) });
    expect(getView("a")!.ask).toBe(first.ask);
    global().emit("status", { id: "a", run: run({ status: "waiting", ask: ask("q2", "location", { description: "the notes", kind: "file" }) }) });
    expect(getView("a")!.ask!.ask).toEqual({ needsLocation: { description: "the notes", kind: "file" } });
    global().emit("status", { id: "a", run: run({ status: "waiting", ask: ask("q3", "approval", { tool: "run_command" }) }) });
    expect(getView("a")!.ask!.ask).toEqual({ needsApproval: { tool: "run_command" } });
    global().emit("status", { id: "a", run: run() });
    expect(getView("a")!.ask).toBeNull();
    expect(needsYou(getView("a"))).toBe(false);
  });

  it("subscribeAll hears the ask before the status that goes with it", () => {
    const seen: RunnerEvent[] = [];
    subscribeAll((e) => seen.push(e));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    global().emit("status", { id: "a", run: run({ status: "waiting", ask: ask("q1", "approval", {}) }) });
    expect(seen.map((e) => e.kind)).toEqual(["status", "ask"]);
  });

  it("decide sends yes or no as approve, with the ask's id", async () => {
    global().emit("snapshot", { runs: [{ id: "a", run: run({ status: "waiting", ask: ask("q1", "approval", {}) }) }] });
    getView("a")!.ask!.decide(true);
    await flush();
    expect(commands()).toEqual([{ method: "POST", path: "/api/sessions/a/commands/approve", body: { askId: "q1", allow: true } }]);
  });

  it("decide sends the picked paths as answer", async () => {
    global().emit("snapshot", { runs: [{ id: "a", run: run({ status: "waiting", ask: ask("q1", "location", { description: "x", kind: "file" }) }) }] });
    getView("a")!.ask!.decide([{ path: "/p/x.md", kind: "file" }]);
    await flush();
    expect(commands()[0]).toMatchObject({
      path: "/api/sessions/a/commands/answer",
      body: { askId: "q1", paths: [{ path: "/p/x.md", kind: "file" }] },
    });
  });

  it("an answer that is late (the first one won) is not shown as an error", async () => {
    global().emit("snapshot", { runs: [{ id: "a", run: run({ status: "waiting", ask: ask("q1", "approval", {}) }) }] });
    serve(() => ({ status: 409, body: { error: "Already answered", reason: "stale ask" } }));
    getView("a")!.ask!.decide(false);
    await flush();
    expect(getView("a")!.error).toBeNull();
  });

  it("any other refusal shows as the run's error until the next event", async () => {
    global().emit("snapshot", { runs: [{ id: "a", run: run({ status: "waiting", ask: ask("q1", "location", { description: "x", kind: "file" }) }) }] });
    serve(() => ({ status: 409, body: { error: "That question asks for a file or folder.", reason: "wrong answer" } }));
    getView("a")!.ask!.decide(true);
    await flush();
    expect(getView("a")!.error).toBe("That question asks for a file or folder.");
    global().emit("status", { id: "a", run: run({ status: "waiting", ask: ask("q1", "location", { description: "x", kind: "file" }) }) });
    expect(getView("a")!.error).toBeNull();
  });
});

describe("commands", () => {
  it("startRun sends the page's choices and answers once the run shows", async () => {
    const p = startRun("a", { connectorId: "c1", model: "m", toolsOn: true, thinkOn: false, freshSteps: true });
    let done = false;
    void p.then(() => (done = true));
    subscribeAll(() => {});
    await vi.waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0]).toEqual({
      method: "POST",
      path: "/api/sessions/a/commands/run",
      body: { connectorId: "c1", model: "m", toolsOn: true, thinkOn: false, freshSteps: true },
    });
    await flush();
    expect(done).toBe(false);
    global().emit("status", { id: "a", run: run() });
    await p;
    expect(getView("a")).toBeDefined();
  });

  it("startRun gives up waiting for the run to show after a moment, and still resolves", async () => {
    vi.useFakeTimers();
    const p = startRun("a", { connectorId: "c1", model: "m", toolsOn: false, thinkOn: false });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(START_WAIT_MS);
    await expect(p).resolves.toBeUndefined();
  });

  it("startRun throws the server's plain refusal", async () => {
    serve(() => ({ status: 409, body: { error: "This plan is already running.", reason: "already running" } }));
    await expect(startRun("a", { connectorId: "c1", model: "m", toolsOn: false, thinkOn: false })).rejects.toMatchObject({
      message: "This plan is already running.",
      data: { reason: "already running" },
    });
  });

  it("pause and resume are commands, and a run that just ended is not an error", async () => {
    await pause("a");
    await resume("a");
    expect(commands().map((c) => c.path)).toEqual(["/api/sessions/a/commands/pause", "/api/sessions/a/commands/resume"]);
    serve(() => ({ status: 409, body: { error: "No plan is running in this session.", reason: "not running" } }));
    await expect(pause("a")).resolves.toBeUndefined();
  });

  it("any other refusal of pause is thrown", async () => {
    serve(() => ({ status: 500, body: { error: "Broke" } }));
    await expect(pause("a")).rejects.toMatchObject({ message: "Broke" });
  });

  it("stop answers only once the run is over and its final session is in hand", async () => {
    const views: RunnerView[] = [];
    subscribe("a", (v) => views.push(v));
    global().emit("snapshot", { runs: [{ id: "a", run: run() }] });
    let done = false;
    const p = stop("a").then(() => (done = true));
    await flush();
    expect(commands().map((c) => c.path)).toEqual(["/api/sessions/a/commands/stop"]);
    expect(done).toBe(false);
    serve(() => ({ body: { ...session("a", { title: "After stop" }), revision: 20 } }));
    global().emit("status", { id: "a", run: null });
    await p;
    expect(views.at(-1)).toMatchObject({ status: "stopped" });
    expect(views.at(-1)!.session?.title).toBe("After stop");
  });

  it("stop with no run answers at once", async () => {
    serve(() => ({ status: 409, body: { error: "No plan is running in this session.", reason: "not running" } }));
    await expect(stop("a")).resolves.toBeUndefined();
  });
});

describe("needsYou", () => {
  const view = (extra: Partial<RunnerView>): RunnerView => ({
    sessionId: "a",
    session: session("a"),
    status: "running",
    ask: null,
    error: null,
    streaming: false,
    startedAt: 1,
    ...extra,
  });
  it("is false for nothing and for a plain running view", () => {
    expect(needsYou(undefined)).toBe(false);
    expect(needsYou(null)).toBe(false);
    expect(needsYou(view({}))).toBe(false);
  });
  it("is true for a pending ask", () => {
    expect(needsYou(view({ ask: { ask: { needsApproval: {} as any }, decide: () => {} } }))).toBe(true);
  });
  it("is true when it ended with a waiting step, false for other ends and for no session", () => {
    const waiting = session("a", { plan: [{ id: "s1", text: "One", status: "waiting" }] });
    expect(needsYou(view({ status: "stopped", session: waiting }))).toBe(true);
    expect(needsYou(view({ status: "stopped" }))).toBe(false);
    expect(needsYou(view({ status: "stopped", session: null }))).toBe(false);
    expect(needsYou(view({ status: "running", session: waiting }))).toBe(false);
  });
});

describe("pauseControl", () => {
  it("offers Pause only while running", () => {
    expect(pauseControl("running")).toEqual({ text: null, button: "Pause" });
  });
  it("says Pausing after this step, without a button", () => {
    expect(pauseControl("pausing")).toEqual({ text: "Pausing after this step", button: null });
  });
  it("says Paused and offers Resume", () => {
    expect(pauseControl("paused")).toEqual({ text: "Paused", button: "Resume" });
  });
  it("offers nothing while waiting, stopped or without a run", () => {
    for (const s of ["waiting", "stopped", undefined, null] as const) {
      expect(pauseControl(s)).toEqual({ text: null, button: null });
    }
  });
});
