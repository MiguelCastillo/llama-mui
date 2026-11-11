import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_REPLY_QUOTE } from "../../src/api.ts";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import type { CommandDeps } from "../commands.ts";
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
const env = { connector: null, model: "m", models: [], toolContext: { definitions: [], checkCommands: {} }, toolsOn: false, modelOptions: {} } as unknown as RunnerEnv;
const deps: CommandDeps = {
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
async function command(id: string, name: string, body: unknown = {}, method = "POST", withDeps: CommandDeps | null = deps) {
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

const options = { connectorId: "c", model: "m", toolsOn: true, modelOptions: { think: false } };
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
    expect(r.body).toEqual({ ok: true, revision: fileOf("a").revision, sessionId: "a" });
    expect(hub.liveRun("a")).toMatchObject({ status: "running" });
  });

  it("says which session the plan runs in when the starter moved it to a thread", async () => {
    saved("a");
    saved("t");
    const start = vi.fn(async () => ({ sessionId: "t" }));
    const r = await command("a", "run", options, "POST", { start });
    expect(r.status).toBe(200);
    // The revision is the thread's, the session the page goes on to show.
    expect(r.body).toEqual({ ok: true, revision: fileOf("t").revision, sessionId: "t" });
  });

  it("hands the starter exactly what the page chose", async () => {
    saved("a");
    const start = vi.fn(async () => {});
    await command("a", "run", { ...options, freshSteps: false, extra: "ignored" }, "POST", { start });
    expect(start).toHaveBeenCalledWith("a", { connectorId: "c", model: "m", toolsOn: true, modelOptions: { think: false }, freshSteps: false });
  });

  it("passes the settings object on whole, and checks it", async () => {
    saved("a");
    const start = vi.fn(async () => {});
    const { modelOptions: _, ...bare } = options;
    await command("a", "run", { ...bare, modelOptions: { think: true, effort: "max" } }, "POST", { start });
    expect(start).toHaveBeenLastCalledWith("a", { ...bare, modelOptions: { think: true, effort: "max" } });
    // Settings that aren't any kind's are dropped; none at all is an empty object.
    await command("a", "run", { ...bare, modelOptions: { other: 1 } }, "POST", { start });
    expect(start).toHaveBeenLastCalledWith("a", { ...bare, modelOptions: {} });
    await command("a", "run", bare, "POST", { start });
    expect(start).toHaveBeenLastCalledWith("a", { ...bare, modelOptions: {} });
    for (const bad of [{ effort: "extreme" }, { think: "yes" }, "think", ["think"], null]) {
      const r = await command("a", "run", { ...bare, modelOptions: bad }, "POST", { start });
      expect(r.status).toBe(400);
    }
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("reads an older page's thinkOn and effort as the settings object", async () => {
    saved("a");
    const start = vi.fn(async () => {});
    const { modelOptions: _, ...bare } = options;
    await command("a", "run", { ...bare, thinkOn: true, effort: "high" }, "POST", { start });
    expect(start).toHaveBeenLastCalledWith("a", { ...bare, modelOptions: { think: true, effort: "high" } });
    await command("a", "run", { ...bare, thinkOn: false, effort: null }, "POST", { start });
    expect(start).toHaveBeenLastCalledWith("a", { ...bare, modelOptions: { think: false } });
    expect((await command("a", "run", { ...bare, thinkOn: "no" }, "POST", { start })).status).toBe(400);
    expect((await command("a", "run", { ...bare, effort: "extreme" }, "POST", { start })).status).toBe(400);
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

describe("stop", () => {
  it("ends the run now and answers once it is over, keeping the plan", async () => {
    saved("a");
    await command("a", "run", options);
    await settle();
    finish("a", "s1");
    await vi.waitFor(() => expect(started).toEqual(["s1", "s2"]));
    expect(hub.liveRun("a")!.status).toBe("running");

    const stopped = await command("a", "stop");
    expect(stopped.status).toBe(200);
    // It answered once the run was over, with the revision of the final save.
    expect(hub.liveRun("a")).toBeNull();
    expect(stopped.body.revision).toBe(fileOf("a").revision);
    expect(fileOf("a").plan.map((s: any) => s.status)).toEqual(["done", "pending"]);
    expect(fileOf("a").plan[1].note).toBe("Paused");
  });

  it("is refused with a plain reason when nothing runs", async () => {
    saved("a");
    const r = await command("a", "stop");
    expect(r).toMatchObject({ status: 409, body: { reason: "not running", error: "No plan is running in this session." } });
  });

  it("is the only way to end a run: pause and resume are unknown commands", async () => {
    saved("a");
    for (const name of ["pause", "resume"]) expect((await command("a", name)).status).toBe(404);
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

  it("plan on a command approval passes \"plan\" on, as a no that asks for a plan", async () => {
    saved("a", 1);
    askOn("a", "s1", { needsApproval: { type: "command", command: "npm i", cwd: "/w" } } as any);
    await command("a", "run", options);
    const askId = await waitingFor();
    expect((await command("a", "approve", { askId, allow: false, plan: true })).status).toBe(200);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).toBe("plan"));
  });

  for (const [name, needsApproval] of [
    ["a file change", { type: "change", path: "/w/a", diff: "" }],
    ["a worktree removal", { type: "worktree", action: "remove", repo: "/r", branch: "b", path: "/w/x" }],
    ["a page", { type: "page", url: "https://example.com", host: "example.com" }],
  ] as const) {
    it(`plan is accepted on ${name}, and still refused with a yes`, async () => {
      saved("a", 1);
      askOn("a", "s1", { needsApproval } as any);
      await command("a", "run", options);
      const askId = await waitingFor();
      expect((await command("a", "approve", { askId, allow: true, plan: true })).status).toBe(400);
      expect((await command("a", "approve", { askId, allow: false, plan: "yes" })).status).toBe(400);
      expect(hub.liveRun("a")!.ask!.id).toBe(askId);
      expect((await command("a", "approve", { askId, allow: false, plan: true })).status).toBe(200);
      await vi.waitFor(() => expect(askedAnswer("a", "s1")).toBe("plan"));
    });
  }

  it("plan on a question about a path (a thing to find) is not refused either", async () => {
    saved("a", 1);
    askOn("a", "s1", { needsLocation: { description: "the notes", kind: "folder" } });
    await command("a", "run", options);
    const askId = await waitingFor();
    expect((await command("a", "approve", { askId, allow: false, plan: true })).status).toBe(200);
    await vi.waitFor(() => expect(askedAnswer("a", "s1")).toBe("plan"));
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

  it("answer keeps asWorkingDir for a folder and drops it for anything else", async () => {
    saved("a", 1);
    askOn("a", "s1", { needsLocation: { description: "the notes", kind: "folder", canSetWorkingDir: true } });
    await command("a", "run", options);
    const askId = await waitingFor();
    const paths = [
      { path: "/notes", kind: "folder", asWorkingDir: true },
      { path: "/n.txt", kind: "file", asWorkingDir: true },
      { path: "/other", kind: "folder", asWorkingDir: "yes" },
    ];
    expect((await command("a", "answer", { askId, paths })).status).toBe(200);
    await vi.waitFor(() =>
      expect(askedAnswer("a", "s1")).toEqual([
        { path: "/notes", kind: "folder", asWorkingDir: true },
        { path: "/n.txt", kind: "file" },
        { path: "/other", kind: "folder" },
      ]),
    );
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

describe("message", () => {
  it("answers with the step that will see it, and the run keeps it until that step starts", async () => {
    saved("a", 3);
    await command("a", "run", options);
    await settle(); // step 1 is in flight
    const r = await command("a", "message", { text: "  Use tabs, not spaces  " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, step: 2, stepId: "s2" });
    expect(typeof r.body.messageId).toBe("string");
    expect(hub.liveRun("a")!.notes).toEqual([{ id: r.body.messageId, text: "Use tabs, not spaces", step: 2, stepId: "s2" }]);
  });

  it("is refused when no step is left to see it, and says so plainly", async () => {
    saved("a", 1);
    await command("a", "run", options);
    await settle(); // the only step is in flight
    const r = await command("a", "message", { text: "Also add a README" });
    expect(r).toMatchObject({ status: 409, body: { reason: "no step left" } });
    expect(r.body.error).toMatch(/last one is already running/);
    expect(r.body.error).toMatch(/still in the box/);
    expect(hub.liveRun("a")!.notes).toBeUndefined();
  });

  it("checks the text", async () => {
    saved("a");
    await command("a", "run", options);
    await settle();
    expect((await command("a", "message", {})).status).toBe(400);
    expect((await command("a", "message", { text: "   " })).status).toBe(400);
    expect((await command("a", "message", { text: 5 })).status).toBe(400);
  });
});

describe("ask: a side question beside a running plan", () => {
  it("hands the starter the text and exactly what the page chose, and answers once it has begun", async () => {
    saved("a", 3);
    await command("a", "run", options);
    await settle();
    const aside = vi.fn(async () => {});
    const r = await command("a", "ask", { ...options, text: "  What is it doing?  ", extra: "ignored" }, "POST", { ...deps, aside });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, revision: fileOf("a").revision });
    expect(aside).toHaveBeenCalledWith("a", "  What is it doing?  ", { connectorId: "c", model: "m", toolsOn: true, modelOptions: { think: false } });
    // The plan is not told: no note is kept for a step.
    expect(hub.liveRun("a")!.notes).toBeUndefined();
  });

  it("is refused with a plain reason when no plan runs, so the page sends a normal message", async () => {
    saved("a");
    const aside = vi.fn(async () => {});
    const r = await command("a", "ask", { ...options, text: "hello" }, "POST", { ...deps, aside });
    expect(r).toMatchObject({ status: 409, body: { reason: "not running" } });
    expect(r.body.error).toMatch(/normal message/);
    expect(aside).not.toHaveBeenCalled();
  });

  it("passes the starter's refusal on when a side question is being answered already", async () => {
    saved("a", 3);
    await command("a", "run", options);
    await settle();
    const aside = async () => {
      throw new HttpError(409, "A side question is still being answered.", { reason: "aside running" });
    };
    expect(await command("a", "ask", { ...options, text: "again" }, "POST", { ...deps, aside })).toMatchObject({
      status: 409,
      body: { reason: "aside running", error: "A side question is still being answered." },
    });
  });

  it("stop with aside ends only the side question; the plan goes on", async () => {
    saved("a", 3);
    await command("a", "run", options);
    await settle();
    // None is being answered: a plain refusal, and nothing is stopped.
    expect(await command("a", "stop", { aside: true })).toMatchObject({ status: 409, body: { reason: "not running" } });
    expect(hub.liveRun("a")).toMatchObject({ status: "running" });
    // One is: the run says so, and the command aborts it alone.
    const slot = runners.openAside("a");
    await vi.waitFor(() => expect(hub.liveRun("a")?.aside).toBe(true));
    expect((await command("a", "stop", { aside: true })).status).toBe(200);
    expect(slot.controller.signal.aborted).toBe(true);
    slot.release();
    await vi.waitFor(() => expect(hub.liveRun("a")?.aside).toBeUndefined());
    expect(hub.liveRun("a")).toMatchObject({ status: "running" });
  });

  it("says plainly what is wrong with the request", async () => {
    saved("a", 3);
    await command("a", "run", options);
    await settle();
    const aside = vi.fn(async () => {});
    const sent = (body: unknown) => command("a", "ask", body, "POST", { ...deps, aside });
    expect((await sent({ ...options })).body.error).toMatch(/text must be given/);
    expect((await sent({ ...options, text: "   " })).status).toBe(400);
    expect((await sent({ ...options, text: 5 })).status).toBe(400);
    expect((await sent({ text: "hi" })).body.error).toMatch(/connectorId must be given/);
    expect(aside).not.toHaveBeenCalled();
  });
});

describe("message with no run: one chat reply, run here", () => {
  const chatOptions = { ...options, planning: false };

  it("hands the starter the text and exactly what the page chose, planning included", async () => {
    saved("a");
    const chat = vi.fn(async () => {});
    const r = await command("a", "message", { ...chatOptions, text: "hello", planning: true, extra: "ignored" }, "POST", { ...deps, chat });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, revision: fileOf("a").revision });
    expect(chat).toHaveBeenCalledWith("a", "hello", { connectorId: "c", model: "m", toolsOn: true, modelOptions: { think: false }, planning: true });
    // Without the flag it is an ordinary reply.
    await command("a", "message", { ...options, text: "again" }, "POST", { ...deps, chat });
    expect(chat).toHaveBeenLastCalledWith("a", "again", expect.objectContaining({ planning: false }));
  });

  it("hands the starter the response being replied to, cut short if very long, and ignores a blank one", async () => {
    saved("a");
    const chat = vi.fn(async () => {});
    const sent = (replyTo: unknown) => command("a", "message", { ...chatOptions, text: "why?", replyTo }, "POST", { ...deps, chat });
    expect((await sent("Use a map.")).status).toBe(200);
    expect(chat).toHaveBeenLastCalledWith("a", "why?", expect.objectContaining({ replyTo: "Use a map." }));
    await sent("x".repeat(MAX_REPLY_QUOTE + 500));
    const kept = (chat.mock.calls.at(-1) as any)[2].replyTo as string;
    expect(kept).toBe(`${"x".repeat(MAX_REPLY_QUOTE)}…`);
    await sent("   ");
    expect((chat.mock.calls.at(-1) as any)[2].replyTo).toBeUndefined();
  });

  it("refuses a replyTo that isn't text", async () => {
    saved("a");
    const chat = vi.fn(async () => {});
    for (const bad of [5, { text: "x" }, ["x"], true]) {
      const r = await command("a", "message", { ...chatOptions, text: "why?", replyTo: bad }, "POST", { ...deps, chat });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/replyTo must be text/);
    }
    expect(chat).not.toHaveBeenCalled();
  });

  it("says plainly what is wrong with the request", async () => {
    saved("a");
    const chat = vi.fn(async () => {});
    const sent = (body: unknown) => command("a", "message", body, "POST", { ...deps, chat });
    expect((await sent({ text: "hello" })).body.error).toMatch(/connectorId must be given/);
    expect((await sent({ ...chatOptions, text: "hello", model: "" })).status).toBe(400);
    expect((await sent({ ...chatOptions, text: "hello", planning: "yes" })).body.error).toMatch(/planning must be true or false/);
    expect(chat).not.toHaveBeenCalled();
  });

  it("passes the starter's refusal on, so the page keeps the text", async () => {
    saved("a");
    const chat = async () => {
      throw new HttpError(409, "This session is busy.", { reason: "already running" });
    };
    expect(await command("a", "message", { ...chatOptions, text: "hello" }, "POST", { ...deps, chat })).toMatchObject({
      status: 409,
      body: { reason: "already running", error: "This session is busy." },
    });
  });

  it("goes to the plan, not to a new reply, while a plan runs", async () => {
    saved("a", 3);
    await command("a", "run", options);
    await settle();
    const chat = vi.fn(async () => {});
    const r = await command("a", "message", { ...chatOptions, text: "Use tabs" }, "POST", { ...deps, chat });
    expect(r.body).toMatchObject({ ok: true, step: 2 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("refuses images while a plan runs", async () => {
    saved("a", 3);
    await command("a", "run", options);
    await settle();
    const r = await command("a", "message", { ...chatOptions, text: "hi", images: [{ id: "x", mediaType: "image/png" }] });
    expect(r).toMatchObject({ status: 409, body: { reason: "reply running" } });
    expect(r.body.error).toMatch(/Images can't be attached/);
  });

  it("passes images through to the chat starter when no run is active", async () => {
    // Create a real image file so validateRefs finds it.
    const { save: saveImage } = await import("../images.ts");
    const img = await saveImage("a", Buffer.from([0x89, 0x50]), "image/png");
    saved("a");
    const chat = vi.fn(async () => {});
    const r = await command("a", "message", { ...chatOptions, text: "look", images: [{ id: img.id, mediaType: img.mediaType }] }, "POST", { ...deps, chat });
    expect(r.status).toBe(200);
    expect(chat).toHaveBeenCalledWith("a", "look", expect.objectContaining({
      images: [{ id: img.id, mediaType: img.mediaType }],
    }));
  });

  it("accepts images with no text when no run is active", async () => {
    const { save: saveImage } = await import("../images.ts");
    const img = await saveImage("a", Buffer.from([0x89, 0x50]), "image/png");
    saved("a");
    const chat = vi.fn(async () => {});
    const r = await command("a", "message", { ...chatOptions, text: "", images: [{ id: img.id, mediaType: img.mediaType }] }, "POST", { ...deps, chat });
    expect(r.status).toBe(200);
    expect(chat).toHaveBeenCalledWith("a", "", expect.objectContaining({
      images: [{ id: img.id, mediaType: img.mediaType }],
    }));
  });

  it("rejects images with no text and no images", async () => {
    saved("a");
    const r = await command("a", "message", { ...chatOptions, text: "", images: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/images must be a non-empty list/);
  });

  it("rejects images with no text while a plan runs", async () => {
    saved("a", 3);
    await command("a", "run", options);
    await settle();
    const r = await command("a", "message", { text: "", images: [{ id: "x", mediaType: "image/png" }] });
    expect(r).toMatchObject({ status: 409, body: { reason: "reply running" } });
    expect(r.body.error).toMatch(/Images can't be attached/);
  });
});

describe("message while a chat reply streams: it waits in the session's queue", () => {
  const chatOptions = { ...options, planning: false };
  let release: (ok: boolean) => void = () => {};

  // A reply that streams until the test lets it finish (or Stop aborts it).
  const blockingReply = (h: any) => {
    handles.set(h.sessionId, h);
    return async (_text: string, before: any[]) => {
      const controller = new AbortController();
      h.setAbort(controller);
      try {
        const ok = await new Promise<boolean>((resolve) => {
          release = resolve;
          controller.signal.addEventListener("abort", () => resolve(false));
        });
        return { ok, messages: before };
      } finally {
        h.setAbort(null);
      }
    };
  };
  async function startReply(id = "a") {
    putFile(id, { ...makeSession(id, 0), plan: null, messages: [], revision: 1 });
    const turn = await runners.startTurn(id, env, { text: "first", planning: false }, { reply: blockingReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => expect(hub.liveRun(id)).toMatchObject({ kind: "turn", streaming: true }));
    return turn;
  }
  const queueOf = (id = "a") => (fileOf(id).queue ?? []) as any[];

  it("queues it with the choices it was typed with, and starts no second reply", async () => {
    const turn = await startReply();
    const chat = vi.fn(async () => {});
    const r = await command("a", "message", { ...chatOptions, text: "and then?", planning: true, replyTo: "Use a map." }, "POST", { ...deps, chat });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, revision: fileOf("a").revision, queued: true, messageId: expect.any(String) });
    expect(chat).not.toHaveBeenCalled();
    expect(queueOf()).toEqual([
      {
        id: r.body.messageId,
        text: "and then?",
        options: { connectorId: "c", model: "m", toolsOn: true, modelOptions: { think: false }, planning: true },
        replyTo: "Use a map.",
        queuedAt: expect.any(Number),
      },
    ]);
    // A message sent with other settings keeps them in the queue.
    await command("a", "message", { ...chatOptions, text: "harder", modelOptions: { think: true, effort: "high" } }, "POST", { ...deps, chat });
    expect(queueOf()[1].options).toEqual({ connectorId: "c", model: "m", toolsOn: true, modelOptions: { think: true, effort: "high" }, planning: false });
    // The reply is untouched.
    expect(hub.liveRun("a")).toMatchObject({ kind: "turn", status: "running", streaming: true });
    release(true);
    await turn.done;
  });

  it("keeps the order, and the image refs", async () => {
    const { save: saveImage } = await import("../images.ts");
    const img = await saveImage("a", Buffer.from([0x89, 0x50]), "image/png");
    const turn = await startReply();
    const one = await command("a", "message", { ...chatOptions, text: "one" });
    const two = await command("a", "message", { ...chatOptions, text: "two", images: [{ id: img.id, mediaType: img.mediaType }] });
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body.messageId).not.toBe(two.body.messageId);
    expect(queueOf().map((m) => m.text)).toEqual(["one", "two"]);
    expect(queueOf()[0].images).toBeUndefined();
    expect(queueOf()[1].images).toEqual([{ id: img.id, mediaType: img.mediaType }]);
    release(true);
    await turn.done;
  });

  it("refuses the eleventh with a plain 409 and keeps the ten", async () => {
    const turn = await startReply();
    for (let n = 1; n <= 10; n++) expect((await command("a", "message", { ...chatOptions, text: `m${n}` })).status).toBe(200);
    const r = await command("a", "message", { ...chatOptions, text: "m11" });
    expect(r).toMatchObject({ status: 409, body: { reason: "queue full" } });
    expect(r.body.error).toMatch(/10 messages are already waiting/);
    expect(queueOf().map((m) => m.text)).toEqual(Array.from({ length: 10 }, (_, n) => `m${n + 1}`));
    release(true);
    await turn.done;
  });

  it("asks for some text, queues nothing, and checks the choices like any message", async () => {
    const turn = await startReply();
    expect(await command("a", "message", { ...chatOptions, text: "   " })).toMatchObject({ status: 400 });
    expect((await command("a", "message", { text: "hi" })).body.error).toMatch(/connectorId must be given/);
    expect((await command("a", "message", { ...chatOptions, text: "hi", planning: "yes" })).status).toBe(400);
    expect(queueOf()).toEqual([]);
    release(true);
    await turn.done;
  });

  it("is a normal reply again once the reply has ended", async () => {
    const turn = await startReply();
    release(true);
    await turn.done;
    const chat = vi.fn(async () => {});
    const r = await command("a", "message", { ...chatOptions, text: "next" }, "POST", { ...deps, chat });
    expect(r.body).toEqual({ ok: true, revision: fileOf("a").revision });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(queueOf()).toEqual([]);
  });
});

describe("queue-remove, queue-clear and queue-send", () => {
  const item = (n: number, extra: object = {}) => ({
    id: `q${n}`,
    text: `m${n}`,
    options: { connectorId: "c", model: "m", toolsOn: true, modelOptions: { think: false }, planning: false },
    queuedAt: n,
    ...extra,
  });
  const queued = (items: any[], paused = false) =>
    putFile("a", { ...makeSession("a", 0), plan: null, messages: [], revision: 1, queue: items, queuePaused: paused });
  const queueOf = () => (fileOf("a").queue ?? []) as any[];
  let release: (ok: boolean) => void = () => {};
  const blockingReply = (h: any) => {
    handles.set(h.sessionId, h);
    return async (_text: string, before: any[]) => {
      const ok = await new Promise<boolean>((resolve) => (release = resolve));
      return { ok, messages: before };
    };
  };

  it("queue-remove takes out only that message, in order, and answers the revision", async () => {
    queued([item(1), item(2), item(3)], true);
    const r = await command("a", "queue-remove", { id: "q2" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, revision: fileOf("a").revision } });
    expect(queueOf().map((m) => m.id)).toEqual(["q1", "q3"]);
    // Still paused: there are messages left.
    expect(fileOf("a").queuePaused).toBe(true);
  });

  it("queue-remove of the last message clears the pause", async () => {
    queued([item(1)], true);
    expect((await command("a", "queue-remove", { id: "q1" })).status).toBe(200);
    expect(queueOf()).toEqual([]);
    expect(fileOf("a").queuePaused).toBe(false);
  });

  it("queue-remove of a message that is gone is a 409 'not queued'; no id is a 400", async () => {
    queued([item(1)]);
    expect(await command("a", "queue-remove", { id: "nope" })).toMatchObject({ status: 409, body: { reason: "not queued" } });
    expect((await command("a", "queue-remove", {})).status).toBe(400);
    expect(queueOf().map((m) => m.id)).toEqual(["q1"]);
  });

  it("queue-clear empties the queue and clears the pause", async () => {
    queued([item(1), item(2)], true);
    const r = await command("a", "queue-clear");
    expect(r).toMatchObject({ status: 200, body: { ok: true, revision: fileOf("a").revision } });
    expect(queueOf()).toEqual([]);
    expect(fileOf("a").queuePaused).toBe(false);
  });

  it("queue-clear on an empty queue is fine", async () => {
    queued([]);
    expect((await command("a", "queue-clear")).status).toBe(200);
  });

  it("queue-send starts the first message with its saved choices, un-pauses, and leaves the rest", async () => {
    queued([item(1, { replyTo: "Use a map.", images: [{ id: "i1", mediaType: "image/png" }], options: { ...item(1).options, planning: true } }), item(2)], true);
    const chat = vi.fn(async () => {});
    const r = await command("a", "queue-send", {}, "POST", { ...deps, chat });
    expect(r).toMatchObject({ status: 200, body: { ok: true, revision: fileOf("a").revision } });
    expect(chat).toHaveBeenCalledWith("a", "m1", {
      connectorId: "c",
      model: "m",
      toolsOn: true,
      modelOptions: { think: false },
      planning: true,
      images: [{ id: "i1", mediaType: "image/png" }],
      replyTo: "Use a map.",
    });
    expect(queueOf().map((m) => m.id)).toEqual(["q2"]);
    expect(fileOf("a").queuePaused).toBe(false);
  });

  it("queue-send sends the settings the message was queued with", async () => {
    queued([item(1, { options: { ...item(1).options, modelOptions: { think: true, effort: "low" } } })]);
    const chat = vi.fn(async () => {});
    await command("a", "queue-send", {}, "POST", { ...deps, chat });
    expect(chat).toHaveBeenCalledWith("a", "m1", expect.objectContaining({ modelOptions: { think: true, effort: "low" } }));
  });

  it("queue-send with nothing waiting is a 409 'nothing to run'", async () => {
    queued([], true);
    const chat = vi.fn(async () => {});
    expect(await command("a", "queue-send", {}, "POST", { ...deps, chat })).toMatchObject({ status: 409, body: { reason: "nothing to run" } });
    expect(chat).not.toHaveBeenCalled();
  });

  it("queue-send while a reply runs is a 409 'reply running' and changes nothing", async () => {
    queued([item(1)], false);
    const turn = await runners.startTurn("a", env, { text: "first", planning: false }, { reply: blockingReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => expect(hub.liveRun("a")).toMatchObject({ kind: "turn" }));
    const chat = vi.fn(async () => {});
    expect(await command("a", "queue-send", {}, "POST", { ...deps, chat })).toMatchObject({ status: 409, body: { reason: "reply running" } });
    expect(chat).not.toHaveBeenCalled();
    expect(queueOf().map((m) => m.id)).toEqual(["q1"]);
    release(false);
    await turn.done;
  });

  it("queue-send puts the message back at the front, with the pause as it was, if the reply can't start", async () => {
    queued([item(1), item(2)], true);
    const chat = vi.fn(async () => {
      throw new HttpError(409, "That server isn't in the list any more.", { reason: "no connector" });
    });
    const r = await command("a", "queue-send", {}, "POST", { ...deps, chat });
    expect(r).toMatchObject({ status: 409, body: { reason: "no connector" } });
    expect(queueOf().map((m) => m.id)).toEqual(["q1", "q2"]);
    expect(fileOf("a").queuePaused).toBe(true);
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
    expect((await command("a", "stop", {}, "GET")).status).toBe(405);
    expect((await command("../x", "stop")).status).toBe(400);
  });
});
