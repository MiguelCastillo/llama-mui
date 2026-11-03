import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import { askOn, askedAnswer, fakeRun, finish, handles, makeSession, resetFakes, started } from "./fakeRun.ts";
import { fileOf, files, putFile } from "./memorySessions.ts";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui. The session
// files themselves are held in memory (see memorySessions.ts).
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});
vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original<object>()));

const { commandRoutes } = await import("../commands.ts");
const { HttpError } = await import("../http.ts");
const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");

// No model: a run starts from a fake, the way the real `run` command will start one from a real run.
const env = { connector: null, model: "m", models: [], toolContext: { definitions: [], checkCommands: {} }, toolsOn: false, thinkOn: false } as unknown as RunnerEnv;
const deps = {
  start: async (id: string) => {
    await runners.startRunner(id, env, {
      run: (cb) => fakeRun(id, cb),
      save: (s) => hub.save(id, s),
      reply: (h) => {
        handles.set(h.sessionId, h);
        return async (_text, before) => ({ ok: true, messages: before });
      },
    });
  },
};

// Answers the way the plugin does: an HttpError's extra fields sit next to `error`.
async function command(id: string, name: string, body: unknown = {}, method = "POST", withDeps: typeof deps | null = deps) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  try {
    const handled = await commandRoutes({ req, res, parts: ["sessions", id, "commands", name], method, search: "" }, withDeps ?? undefined);
    if (!handled) return { status: 0, body: null as any };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { ...e.extra, error: e.message } as any };
    throw e;
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : null } as { status: number; body: any };
}

const options = { connectorId: "c", model: "m", toolsOn: true, thinkOn: false };
const saved = (id: string, steps = 2) => putFile(id, { ...makeSession(id, steps), revision: 1 });
const settle = () => vi.waitFor(() => expect(hub.liveRun("a")?.streaming).toBe(true));

beforeEach(() => resetFakes());
afterEach(async () => {
  await runners.resetRunners();
  files.clear();
});

describe("run", () => {
  it("starts the plan and answers with the revision", async () => {
    saved("a");
    const r = await command("a", "run", options);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, revision: fileOf("a").revision });
    expect(hub.liveRun("a")).toMatchObject({ status: "running" });
  });

  it("hands the starter exactly what the page chose", async () => {
    saved("a");
    const start = vi.fn(async () => {});
    await command("a", "run", { ...options, freshSteps: false, extra: "ignored" }, "POST", { start });
    expect(start).toHaveBeenCalledWith("a", { connectorId: "c", model: "m", toolsOn: true, thinkOn: false, freshSteps: false });
  });

  it("is refused for a second window running the same plan", async () => {
    saved("a");
    const results = await Promise.all([command("a", "run", options), command("a", "run", options)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect(refused.body.reason).toBe("already running");
    expect(refused.body.error).toBe("This plan is already running.");
    // And later, too.
    expect((await command("a", "run", options)).body.reason).toBe("already running");
  });

  it("says plainly what is wrong with the request, and when there is nothing to run", async () => {
    saved("a");
    expect((await command("a", "run", { ...options, model: "" })).status).toBe(400);
    expect((await command("a", "run", { ...options, toolsOn: "yes" })).body.error).toMatch(/toolsOn must be true or false/);
    expect((await command("a", "run", { ...options, freshSteps: 1 })).status).toBe(400);
    expect((await command("a", "run", {})).status).toBe(400);
    putFile("done", { ...makeSession("done", 1), plan: [{ id: "s1", text: "x", status: "done" }] });
    expect(await command("done", "run", options)).toMatchObject({ status: 409, body: { reason: "nothing to run" } });
    expect((await command("missing", "run", options)).status).toBe(404);
  });
});

describe("pause, resume and stop", () => {
  it("pause holds after the step, resume continues, stop ends it", async () => {
    saved("a");
    await command("a", "run", options);
    await settle();

    expect((await command("a", "pause")).body).toMatchObject({ ok: true });
    expect(hub.liveRun("a")!.status).toBe("pausing");
    finish("a", "s1");
    await vi.waitFor(() => expect(hub.liveRun("a")!.status).toBe("paused"));
    expect(started).toEqual(["s1"]);

    expect((await command("a", "resume")).status).toBe(200);
    await vi.waitFor(() => expect(started).toEqual(["s1", "s2"]));
    expect(hub.liveRun("a")!.status).toBe("running");

    const stopped = await command("a", "stop");
    expect(stopped.status).toBe(200);
    // It answered once the run was over, with the revision of the final save.
    expect(hub.liveRun("a")).toBeNull();
    expect(stopped.body.revision).toBe(fileOf("a").revision);
    expect(fileOf("a").plan.map((s: any) => s.status)).toEqual(["done", "pending"]);
    expect(fileOf("a").plan[1].note).toBe("Stopped");
  });

  it("are refused with a plain reason when nothing runs", async () => {
    saved("a");
    for (const name of ["pause", "resume", "stop"]) {
      const r = await command("a", name);
      expect(r).toMatchObject({ status: 409, body: { reason: "not running", error: "No plan is running in this session." } });
    }
  });
});

describe("approve and answer", () => {
  const approval = { needsApproval: { name: "run_command" } } as any;
  const waitingFor = async () => {
    await vi.waitFor(() => expect(hub.liveRun("a")?.ask).toBeDefined());
    return hub.liveRun("a")!.ask!.id;
  };

  it("approve answers an approval ask, once", async () => {
    saved("a", 1);
    askOn("a", "s1", approval);
    await command("a", "run", options);
    const askId = await waitingFor();

    expect((await command("a", "approve", { askId, allow: true })).status).toBe(200);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).toBe(true));
    // First answer wins.
    const second = await command("a", "approve", { askId, allow: false });
    expect(second).toMatchObject({ status: 409, body: { reason: "stale ask" } });
    expect(askedAnswer("a", "s1")).toBe(true);
  });

  it("refuses an ask id that isn't the pending one", async () => {
    saved("a", 1);
    askOn("a", "s1", approval);
    await command("a", "run", options);
    await waitingFor();
    const r = await command("a", "approve", { askId: "not-the-one", allow: true });
    expect(r).toMatchObject({ status: 409, body: { reason: "stale ask" } });
    expect(hub.liveRun("a")!.status).toBe("waiting");
  });

  it("answer passes on the picked paths for a location ask", async () => {
    saved("a", 1);
    askOn("a", "s1", { needsLocation: { description: "the notes", kind: "folder" } });
    await command("a", "run", options);
    const askId = await waitingFor();
    const picked = [{ path: "/notes", kind: "folder" }];
    expect((await command("a", "answer", { askId, paths: [{ ...picked[0], junk: 1 }] })).status).toBe(200);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).toEqual(picked));
  });

  it("a no turns down a location ask too", async () => {
    saved("a", 1);
    askOn("a", "s1", { needsLocation: { description: "the notes", kind: "folder" } });
    await command("a", "run", options);
    const askId = await waitingFor();
    expect((await command("a", "approve", { askId, allow: false })).status).toBe(200);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).toBe(false));
  });

  it("refuses the wrong kind of answer and goes on waiting", async () => {
    saved("a", 1);
    askOn("a", "s1", { needsLocation: { description: "the notes", kind: "folder" } });
    await command("a", "run", options);
    const askId = await waitingFor();
    expect(await command("a", "approve", { askId, allow: true })).toMatchObject({ status: 409, body: { reason: "wrong answer" } });
    expect(hub.liveRun("a")!.ask!.id).toBe(askId);
  });

  it("has no use for typed text: a waiting step is answered on the plan card", async () => {
    saved("a", 1);
    askOn("a", "s1", approval);
    await command("a", "run", options);
    const askId = await waitingFor();
    const r = await command("a", "answer", { askId, text: "Use the blue one" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/plan card/);
    expect(hub.liveRun("a")!.ask!.id).toBe(askId);
  });

  it("checks what it is given", async () => {
    saved("a", 1);
    askOn("a", "s1", approval);
    await command("a", "run", options);
    const askId = await waitingFor();
    expect((await command("a", "approve", { allow: true })).status).toBe(400);
    expect((await command("a", "approve", { askId })).status).toBe(400);
    expect((await command("a", "approve", { askId, allow: "yes" })).status).toBe(400);
    expect((await command("a", "answer", { askId, paths: [] })).status).toBe(400);
    expect((await command("a", "answer", { askId, paths: [{ path: "/x", kind: "other" }] })).status).toBe(400);
    expect((await command("a", "answer", { askId })).status).toBe(400);
    expect(hub.liveRun("a")!.ask!.id).toBe(askId);
  });

  it("stop releases the ask, and an answer after that is refused", async () => {
    saved("a", 1);
    askOn("a", "s1", approval);
    await command("a", "run", options);
    const askId = await waitingFor();
    expect((await command("a", "stop")).status).toBe(200);
    expect(askedAnswer("a", "s1")).toBe(false);
    expect(await command("a", "approve", { askId, allow: true })).toMatchObject({ status: 409, body: { reason: "not running" } });
  });
});

describe("the route", () => {
  it("ignores paths that aren't commands", async () => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    const res = {} as ServerResponse;
    for (const parts of [["sessions", "a"], ["sessions", "a", "events"], ["sessions", "a", "commands"], ["connectors", "a", "commands", "run"]]) {
      expect(await commandRoutes({ req, res, parts, method: "POST", search: "" }, deps)).toBe(false);
    }
  });

  it("answers an unknown command 404, a GET 405 and a bad id 400", async () => {
    saved("a");
    expect((await command("a", "explode")).status).toBe(404);
    expect((await command("a", "pause", {}, "GET")).status).toBe(405);
    expect((await command("../x", "pause")).status).toBe(400);
  });
});
