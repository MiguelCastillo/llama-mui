import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import type { HubEvent } from "../runHub.ts";
import { fakeRun, finish, handles, makeSession, resetFakes } from "./fakeRun.ts";
import { fileOf, files, putFile } from "./memorySessions.ts";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests write their own settings.json (with a made-up key),
// never the real one. Session files are held in memory (see memorySessions.ts).
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});
vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original<object>()));

const { load, save } = await import("../store.ts");
const { connectorRoutes } = await import("../connectors.ts");
const { setApiOrigin } = await import("../../src/api.ts");
const { startFromOptions, startTurnFromOptions } = await import("../runStart.ts");
const { HttpError } = await import("../http.ts");
const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");

const KEY = "sk-test-secret-0123456789";
const options = { connectorId: "c1", model: "m", toolsOn: true, thinkOn: false, freshSteps: true };
const toolContext = { definitions: [{ name: "read_file" }], systemPrompt: "Use tools.", offered: ["read_file"], update: "", checkCommands: {} };

// The server's own /api, with no network: the connector list is the real route
// (reading a settings.json that holds KEY), the model server and the tools are
// made up. Every request is kept, to see what a run sends.
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  answer: string;
}
const calls: Call[] = [];
let modelsStatus = 200;

async function ownApi(url: string, init: RequestInit = {}): Promise<Response> {
  const { pathname, search } = new URL(url);
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? init.body : "";
  const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}));
  const respond = (status: number, text: string) => {
    calls.push({ url: pathname + search, method, headers, body, answer: text });
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  };
  if (pathname === "/api/connectors" && method === "GET") {
    const req = Object.assign(Readable.from([]), { method, headers: {} }) as unknown as IncomingMessage;
    let text = "";
    const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
    await connectorRoutes({ req, res, parts: ["connectors"], method, search: "" });
    return respond(res.statusCode, text);
  }
  if (pathname === "/api/c/c1/v1/models") {
    return modelsStatus === 200
      ? respond(200, JSON.stringify({ data: [{ id: "m", status: { value: "loaded" } }] }))
      : respond(modelsStatus, JSON.stringify({ error: "Can't reach Studio: connection refused" }));
  }
  if (pathname === "/api/tools/context") return respond(200, JSON.stringify(toolContext));
  return respond(404, JSON.stringify({ error: "Not found" }));
}

const envs: RunnerEnv[] = [];
// No model: the run and the reply are fakes, the rest is what the command does.
const fakes = {
  run: (id: string) => (cb: Parameters<typeof fakeRun>[1]) => fakeRun(id, cb),
  reply: (h: any) => {
    handles.set(h.sessionId, h);
    envs.push(h.env);
    return async (_text: string, before: any) => ({ ok: true, messages: before });
  },
};
const start = (id: string, o = options) => startFromOptions(id, o, { run: fakes.run(id), reply: fakes.reply });
// A plan that was moved in already, so a run starts it where it is (a plan that
// hasn't started moves to a thread: see the tests of that below).
const saved = (id: string, extra: object = {}) => putFile(id, { ...makeSession(id, 2), revision: 1, planMovedIn: true, ...extra });
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err) => err,
  );
  expect(e).toBeInstanceOf(HttpError);
  return e as InstanceType<typeof HttpError>;
};

let events: HubEvent[] = [];
let unsubscribe = () => {};

beforeEach(async () => {
  resetFakes();
  calls.length = 0;
  envs.length = 0;
  modelsStatus = 200;
  await save({
    ...(await load()),
    connectors: [{ id: "c1", name: "Studio", url: "http://127.0.0.1:1", apiKey: KEY, kind: "llama", api: "openai" }],
    activeId: "c1",
  });
  setApiOrigin("http://self.test");
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => ownApi(url, init));
  events = [];
  unsubscribe = hub.subscribe((e) => events.push(e));
});
afterEach(async () => {
  unsubscribe();
  await runners.resetRunners();
  files.clear();
  setApiOrigin(null);
  vi.unstubAllGlobals();
});

describe("the run command's starter", () => {
  it("builds the run from the page's choices, the saved session and the server's own answers", async () => {
    saved("a", { workingDir: "/work/app", attachments: [{ path: "/work/notes.txt", kind: "file", source: "manual" }] });
    await start("a");

    const env = envs[0]!;
    expect(env.model).toBe("m");
    expect(env).toMatchObject({ toolsOn: true, thinkOn: false, freshSteps: true });
    // The connector is the list's entry: that a key is set, not the key.
    expect(env.connector).toEqual({ id: "c1", name: "Studio", url: "http://127.0.0.1:1", hasKey: true, kind: "llama", api: "openai" });
    expect(env.models.map((m) => m.id)).toEqual(["m"]);
    expect(env.toolContext).toEqual(toolContext);
    // The tools were asked for with the session's working directory and its own attachments, and the working directory as the prompt's.
    const context = calls.find((c) => c.url === "/api/tools/context")!;
    expect(JSON.parse(context.body)).toEqual({ workingDir: "/work/app", attachments: ["/work/notes.txt"], promptDir: "/work/app", chatId: "a" });
    expect(hub.liveRun("a")).toMatchObject({ status: "running" });
  });

  it("keeps the prompt's folder a session already fixed, even none", async () => {
    saved("a", { promptDir: null, workingDir: "/work/app", attachments: [{ path: "/work/notes.txt", kind: "file", source: "manual" }] });
    await start("a");
    const context = calls.find((c) => c.url === "/api/tools/context")!;
    expect(JSON.parse(context.body)).toEqual({ workingDir: "/work/app", attachments: ["/work/notes.txt"], promptDir: null, chatId: "a" });
  });

  it("has no working directory, and so no prompt folder, when a folder is only attached", async () => {
    saved("a", { workingDir: null, attachments: [{ path: "/work/app", kind: "folder", source: "manual" }] });
    await start("a");
    const context = calls.find((c) => c.url === "/api/tools/context")!;
    expect(JSON.parse(context.body)).toEqual({ workingDir: null, attachments: ["/work/app"], promptDir: null, chatId: "a" });
  });

  it("holds no key anywhere: not in the run, its events, its requests or the saved session", async () => {
    saved("a");
    await start("a");
    await vi.waitFor(() => expect(hub.liveRun("a")?.streaming).toBe(true));
    // Something to see in the events: step changes, a status change, a save.
    finish("a", "s1");
    await vi.waitFor(() => expect(fileOf("a").plan[0].status).toBe("done"));
    finish("a", "s2");
    await vi.waitFor(() => expect(hub.liveRun("a")).toBeNull());
    await vi.waitFor(() => expect(events.some((e) => e.type === "status" && (e.data as any).run === null)).toBe(true));

    expect(events.length).toBeGreaterThan(3);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(envs)).not.toContain(KEY);
    expect(JSON.stringify(fileOf("a"))).not.toContain(KEY);
    expect(fileOf("a")).not.toHaveProperty("apiKey");
    // The run's own requests carry no key, and none of the answers it read had one:
    // the proxy adds it, upstream, where the run never sees it.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(JSON.stringify(c)).not.toContain(KEY);
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain("x-api-key");
    }
    // The key is in the settings the test wrote, so the check above could have failed.
    expect(JSON.stringify(await load())).toContain(KEY);
  });

  it("refuses a server that isn't in the list, and starts nothing", async () => {
    saved("a");
    const e = await refusal(start("a", { ...options, connectorId: "gone" }));
    expect(e.status).toBe(409);
    expect(e.extra.reason).toBe("no connector");
    expect(e.message).toMatch(/isn't in your list/);
    expect(hub.liveRun("a")).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(["/api/connectors"]);
  });

  it("says plainly when the model server can't be reached, and starts nothing", async () => {
    saved("a");
    modelsStatus = 502;
    const e = await refusal(start("a"));
    expect(e.status).toBe(502);
    expect(e.extra.reason).toBe("unreachable");
    expect(e.message).toBe("The plan didn't start: couldn't ask Studio for its models. Can't reach Studio: connection refused");
    expect(hub.liveRun("a")).toBeNull();
  });

  it("says plainly when the server itself can't be reached", async () => {
    saved("a");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const e = await refusal(start("a"));
    expect(e).toMatchObject({ status: 502, message: "The plan didn't start: couldn't read the list of servers. fetch failed" });
  });

  it("refuses a second start before asking anything", async () => {
    saved("a");
    await start("a");
    calls.length = 0;
    const e = await refusal(start("a"));
    expect(e).toMatchObject({ status: 409, extra: { reason: "already running" } });
    expect(calls).toEqual([]);
  });

  it("says when there is no such session, or no step left", async () => {
    expect((await refusal(start("missing"))).status).toBe(404);
    putFile("done", { ...makeSession("done", 1), plan: [{ id: "s1", text: "x", status: "done" }] });
    expect(await refusal(start("done"))).toMatchObject({ status: 409, extra: { reason: "nothing to run" } });
    expect(hub.liveRun("done")).toBeNull();
  });

  it("answers with the session it runs in: the one it was sent to", async () => {
    saved("a");
    expect(await start("a")).toEqual({ sessionId: "a" });
  });
});

describe("the message command's starter for a chat reply", () => {
  const turnOptions = { ...options, planning: false };
  const said: { text: string; before: any[]; planning?: boolean }[] = [];
  let finishReply: (ok: boolean) => void = () => {};
  // The reply is a fake that waits for the test; the rest is what the starter does.
  const reply = (h: any) => {
    handles.set(h.sessionId, h);
    envs.push(h.env);
    return async (text: string, before: any[], opts: { planning?: boolean } = {}) => {
      said.push({ text, before, planning: opts.planning });
      const messages = [...before, { role: "user", content: text }, { role: "assistant", content: "Fine." }];
      h.edit((s: any) => ({ ...s, messages }));
      const ok = await new Promise<boolean>((resolve) => (finishReply = resolve));
      return { ok, messages };
    };
  };
  const chat = (id: string, text: string, o = turnOptions) => startTurnFromOptions(id, text, o, { reply });
  const history = [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
  ];

  beforeEach(() => {
    said.length = 0;
    finishReply = () => {};
  });

  it("builds the reply's run from the page's choices and the saved session, and sends the text with its history", async () => {
    saved("a", { plan: null, messages: history, workingDir: "/work/app", attachments: [{ path: "/work/notes.txt", kind: "file", source: "manual" }] });
    await chat("a", "And now?");
    await vi.waitFor(() => expect(said).toHaveLength(1));
    expect(said[0]).toEqual({ text: "And now?", before: history, planning: false });
    expect(envs[0]).toMatchObject({ model: "m", toolsOn: true, thinkOn: false });
    // The connector is the list's entry: that a key is set, not the key.
    expect(envs[0].connector).toEqual({ id: "c1", name: "Studio", url: "http://127.0.0.1:1", hasKey: true, kind: "llama", api: "openai" });
    const context = calls.find((c) => c.url === "/api/tools/context")!;
    expect(JSON.parse(context.body)).toEqual({ workingDir: "/work/app", attachments: ["/work/notes.txt"], promptDir: "/work/app", chatId: "a" });
    expect(hub.liveRun("a")).toMatchObject({ kind: "turn", status: "running" });
    finishReply(true);
    await vi.waitFor(() => expect(hub.liveRun("a")).toBeNull());
    expect(fileOf("a").messages.map((m: any) => m.content)).toEqual(["Hi", "Hello!", "And now?", "Fine."]);
  });

  it("passes the planning switch on", async () => {
    saved("a", { plan: null, messages: history });
    await chat("a", "Plan it", { ...turnOptions, planning: true });
    await vi.waitFor(() => expect(said).toHaveLength(1));
    expect(said[0].planning).toBe(true);
    finishReply(true);
    await vi.waitFor(() => expect(hub.liveRun("a")).toBeNull());
  });

  it("holds no key anywhere", async () => {
    saved("a", { plan: null, messages: history });
    await chat("a", "Hello");
    await vi.waitFor(() => expect(said).toHaveLength(1));
    finishReply(true);
    await vi.waitFor(() => expect(hub.liveRun("a")).toBeNull());
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(envs)).not.toContain(KEY);
    expect(JSON.stringify(fileOf("a"))).not.toContain(KEY);
    for (const c of calls) expect(JSON.stringify(c)).not.toContain(KEY);
  });

  it("refuses a server that isn't in the list, and starts nothing", async () => {
    saved("a", { plan: null, messages: history });
    const e = await refusal(chat("a", "Hello", { ...turnOptions, connectorId: "gone" }));
    expect(e).toMatchObject({ status: 409, extra: { reason: "no connector" } });
    expect(hub.liveRun("a")).toBeNull();
    expect(said).toEqual([]);
  });

  it("says plainly when the model server can't be reached, and starts nothing", async () => {
    saved("a", { plan: null, messages: history });
    modelsStatus = 502;
    const e = await refusal(chat("a", "Hello"));
    expect(e).toMatchObject({ status: 502, extra: { reason: "unreachable" } });
    expect(hub.liveRun("a")).toBeNull();
  });

  it("is refused while a reply or a plan already runs, and says the text is still in the box", async () => {
    saved("a", { plan: null, messages: history });
    await chat("a", "First");
    await vi.waitFor(() => expect(said).toHaveLength(1));
    const e = await refusal(chat("a", "Second"));
    expect(e).toMatchObject({ status: 409, extra: { reason: "already running" } });
    expect(e.message).toMatch(/still in the box/);
    expect(said).toHaveLength(1);
    finishReply(true);
    await vi.waitFor(() => expect(hub.liveRun("a")).toBeNull());
  });

  it("is a 404 for a session with no file", async () => {
    expect((await refusal(chat("missing", "Hello"))).status).toBe(404);
  });
});

describe("a plan that hasn't started", () => {
  const request = { role: "user", content: "Please do two things" };
  const fresh = (id: string, extra: object = {}) =>
    saved(id, {
      planMovedIn: false,
      messages: [request, { role: "assistant", content: "Here is a plan." }],
      planSummary: "Do two things",
      planAnchor: "call-1",
      workingDir: "/work/app", attachments: [{ path: "/work/notes.txt", kind: "file", source: "manual" }],
      ...extra,
    });
  // The run is the fake's, bound to the thread the test expects.
  const startThread = (id: string, childId = "child-1", o = options) =>
    startFromOptions(id, o, { run: fakes.run(childId), reply: fakes.reply, newId: () => childId });

  it("moves into a new thread, which is saved first and runs; the session keeps a note", async () => {
    fresh("p");
    expect(await startThread("p")).toEqual({ sessionId: "child-1" });

    // The thread runs, not the session it came from.
    expect(hub.liveRun("child-1")).toMatchObject({ status: "running" });
    expect(hub.liveRun("p")).toBeNull();
    const child = fileOf("child-1");
    expect(child).toMatchObject({ id: "child-1", parentId: "p", title: "Do two things", planSummary: "Do two things", planMovedIn: false });
    expect(child.messages).toEqual([request]);
    expect(child.workingDir).toBe("/work/app");
    expect(child.attachments).toEqual([{ path: "/work/notes.txt", kind: "file", source: "manual" }]);
    expect(child.plan.map((s: any) => s.id)).toEqual(["s1", "s2"]);
    expect(child.planId).toEqual(expect.any(String));
    expect(child.run).toMatchObject({ status: "running" });

    // The session has no plan, and a note that names the thread and its plan.
    const parent = fileOf("p");
    expect(parent.plan).toBeNull();
    expect(parent.threads).toEqual([{ sessionId: "child-1", summary: "Do two things", anchor: "call-1", planId: child.planId }]);
    expect(parent.messages).toHaveLength(2);
    expect(parent.revision).toBe(2);
    expect(parent.run).toBeUndefined();

    // The thread was saved before the session; both reached the list.
    const savedIds = events.filter((e) => e.type === "saved").map((e) => e.id);
    expect(savedIds.slice(0, 2)).toEqual(["child-1", "p"]);
    expect((events.find((e) => e.type === "saved" && e.id === "child-1")!.data as any).summary.parentId).toBe("p");
  });

  it("builds the run from the thread: its own folders and prompt folder", async () => {
    fresh("p", { promptDir: null });
    await startThread("p");
    const context = calls.find((c) => c.url === "/api/tools/context")!;
    // A thread fixes its prompt folder at its own first reply, not the session's.
    expect(JSON.parse(context.body)).toEqual({ workingDir: "/work/app", attachments: ["/work/notes.txt"], promptDir: "/work/app", chatId: "child-1" });
    expect(envs[0]!.connector!.hasKey).toBe(true);
  });

  it("the thread's steps run to the end, and the thread keeps the plan's id", async () => {
    fresh("p");
    await startThread("p");
    await vi.waitFor(() => expect(hub.liveRun("child-1")?.streaming).toBe(true));
    finish("child-1", "s1");
    await vi.waitFor(() => expect(fileOf("child-1").plan[0].status).toBe("done"));
    finish("child-1", "s2");
    await vi.waitFor(() => expect(hub.liveRun("child-1")).toBeNull());
    expect(fileOf("child-1").plan.map((s: any) => s.status)).toEqual(["done", "done"]);
    expect(fileOf("child-1").planId).toBe(fileOf("p").threads[0].planId);
  });

  it("holds no key in the thread, the note or the events", async () => {
    fresh("p");
    await startThread("p");
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(fileOf("child-1"))).not.toContain(KEY);
    expect(JSON.stringify(fileOf("p"))).not.toContain(KEY);
  });

  it("runs in place when the plan was moved in already", async () => {
    fresh("c", { planMovedIn: true, parentId: "p" });
    expect(await startThread("c", "never")).toEqual({ sessionId: "c" });
    expect(hub.liveRun("c")).toMatchObject({ status: "running" });
    expect([...files.keys()]).toEqual(["c"]);
    expect(fileOf("c").threads ?? []).toEqual([]);
  });

  it("runs in place when the plan has started, even a little", async () => {
    fresh("p", { plan: [{ id: "s1", text: "One", status: "done" }, { id: "s2", text: "Two", status: "pending" }] });
    expect(await startThread("p", "never")).toEqual({ sessionId: "p" });
    expect(hub.liveRun("p")).toMatchObject({ status: "running" });
    expect([...files.keys()]).toEqual(["p"]);
  });

  it("makes no thread when the server isn't in the list or can't be reached", async () => {
    fresh("p");
    const before = JSON.stringify(fileOf("p"));
    expect((await refusal(startThread("p", "child-1", { ...options, connectorId: "gone" }))).extra.reason).toBe("no connector");
    modelsStatus = 502;
    expect((await refusal(startThread("p"))).extra.reason).toBe("unreachable");
    expect([...files.keys()]).toEqual(["p"]);
    expect(JSON.stringify(fileOf("p"))).toBe(before);
    expect(events.filter((e) => e.type === "saved")).toEqual([]);
  });

  it("is refused while the session itself runs", async () => {
    fresh("p", { planMovedIn: true });
    await start("p");
    const e = await refusal(startThread("p", "never"));
    expect(e).toMatchObject({ status: 409, extra: { reason: "already running" } });
    expect([...files.keys()]).toEqual(["p"]);
  });

  it("two windows starting the same plan make one thread, not two", async () => {
    fresh("p");
    const run = (childId: string) => startFromOptions("p", options, { run: fakes.run(childId), reply: fakes.reply, newId: () => childId });
    const results = await Promise.allSettled([run("c1"), run("c2")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(HttpError);
    expect(refused[0]!.reason.status).toBe(409);
    expect(refused[0]!.reason.message).toMatch(/changed just now/);
    // The thread that lost was deleted again: one thread, one note.
    const winner = (ok[0] as PromiseFulfilledResult<{ sessionId: string }>).value.sessionId;
    expect([...files.keys()].sort()).toEqual([winner, "p"].sort());
    expect(fileOf("p").threads.map((t: any) => t.sessionId)).toEqual([winner]);
    expect(hub.liveRun(winner)).not.toBeNull();
  });

  it("a save of the session from a page that hasn't seen the move is refused", async () => {
    fresh("p");
    await startThread("p");
    const stale = await hub.replace("p", () => ({ ...makeSession("p", 2) }), 1).then(
      () => null,
      (e) => e,
    );
    expect(stale).toMatchObject({ status: 409, extra: { reason: "stale revision", revision: 2 } });
    expect(fileOf("p").plan).toBeNull();
  });
});
