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
const { startFromOptions } = await import("../runStart.ts");
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
const saved = (id: string, extra: object = {}) => putFile(id, { ...makeSession(id, 2), revision: 1, ...extra });
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
    saved("a", { attachments: [{ path: "/work/app", kind: "folder", source: "manual" }] });
    await start("a");

    const env = envs[0]!;
    expect(env.model).toBe("m");
    expect(env).toMatchObject({ toolsOn: true, thinkOn: false, freshSteps: true });
    // The connector is the list's entry: that a key is set, not the key.
    expect(env.connector).toEqual({ id: "c1", name: "Studio", url: "http://127.0.0.1:1", hasKey: true, kind: "llama", api: "openai" });
    expect(env.models.map((m) => m.id)).toEqual(["m"]);
    expect(env.toolContext).toEqual(toolContext);
    // The tools were asked for with the session's own folders, and its working folder as the prompt's.
    const context = calls.find((c) => c.url === "/api/tools/context")!;
    expect(JSON.parse(context.body)).toEqual({ attachments: ["/work/app"], promptDir: "/work/app" });
    expect(hub.liveRun("a")).toMatchObject({ status: "running" });
  });

  it("keeps the prompt's folder a session already fixed, even none", async () => {
    saved("a", { promptDir: null, attachments: [{ path: "/work/app", kind: "folder", source: "manual" }] });
    await start("a");
    const context = calls.find((c) => c.url === "/api/tools/context")!;
    expect(JSON.parse(context.body)).toEqual({ attachments: ["/work/app"], promptDir: null });
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
});
