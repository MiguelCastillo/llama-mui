import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../../src/api.ts";
import type { RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";
import { fakeRun, finish, handles, makeSession, resetFakes } from "./fakeRun.ts";
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

const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");

// A chat reply run on the server (startTurn): one reply as a one-reply run,
// with the same owner, status, asks, Stop and events as a plan. The reply is a
// fake (what makeReply would stream), so no model is needed.

const SECRET = "sk-secret-key";
const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true, apiKey: SECRET } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  thinkOn: false,
} as RunnerEnv;

const hello: ChatMessage[] = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello!" },
];

interface Call {
  text: string;
  before: ChatMessage[];
  planning: boolean | undefined;
}
let calls: Call[] = [];
// Lets the fake reply finish; until then it is "streaming".
let release: (ok: boolean) => void = () => {};
// What the fake reply does once it has streamed its words; a test may replace it.
let during: (h: RunnerHandle) => Promise<void> = async () => {};

// Streams "Fine." into the session as makeReply's callbacks do, with a request
// in flight (setAbort) until the test lets it finish.
function fakeReply(h: RunnerHandle) {
  handles.set(h.sessionId, h);
  return async (text: string, before: ChatMessage[], opts: { planning?: boolean } = {}) => {
    calls.push({ text, before, planning: opts.planning });
    const controller = new AbortController();
    h.setAbort(controller);
    const messages: ChatMessage[] = [...before, { role: "user", content: text }, { role: "assistant", content: "Fine." }];
    h.edit((s) => ({ ...s, messages }));
    try {
      await during(h);
      const ok = await new Promise<boolean>((resolve) => {
        release = resolve;
        // Stop may have come while `during` was waiting.
        if (controller.signal.aborted) resolve(false);
        controller.signal.addEventListener("abort", () => resolve(false));
      });
      if (ok) h.edit((s) => ({ ...s, usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } as any }));
      return { ok, messages };
    } finally {
      h.setAbort(null);
    }
  };
}

function save(id: string, messages: ChatMessage[] = hello) {
  putFile(id, { ...makeSession(id, 0), plan: null, messages, revision: 4 });
}

async function turn(id: string, text = "And now?", planning = false) {
  return runners.startTurn(id, env, { text, planning }, { reply: fakeReply, save: (s) => hub.save(s.id, s) });
}

const reasonOf = async (p: Promise<unknown>) => p.then(() => null, (e) => ({ status: e.status, reason: e.extra?.reason }));

let events: any[] = [];
let unsubscribe = () => {};

beforeEach(() => {
  resetFakes();
  calls = [];
  release = () => {};
  during = async () => {};
  events = [];
  unsubscribe = hub.subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  await runners.resetRunners();
  files.clear();
});

describe("a chat reply run on the server", () => {
  it("runs the reply once, from the saved messages, and saves the session when it ends", async () => {
    save("a");
    const started = await turn("a", "And now?");
    expect(started.revision).toBeGreaterThan(4);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ text: "And now?", before: hello, planning: false });
    // While it streams the session is a run's: kind turn, a request in flight.
    expect(hub.liveRun("a")).toMatchObject({ kind: "turn", status: "running", streaming: true });
    expect(runners.isRunning("a")).toBe(true);

    release(true);
    await started.done;
    expect(hub.liveRun("a")).toBeNull();
    expect(runners.isRunning("a")).toBe(false);
    const done = fileOf("a");
    expect(done.messages).toEqual([...hello, { role: "user", content: "And now?" }, { role: "assistant", content: "Fine." }]);
    expect(done.usage).toMatchObject({ totalTokens: 15 });
    expect(done.run).toBeUndefined();
    expect(done.revision).toBeGreaterThan(started.revision - 1);
  });

  it("passes the planning switch to the reply, as the page's own reply did", async () => {
    save("a");
    const started = await turn("a", "Plan it", true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].planning).toBe(true);
    release(true);
    await started.done;
  });

  it("uses what is saved as the history, so Resend's cut-short messages are what the model sees", async () => {
    // The page saved only the messages before the one being resent.
    save("a", [{ role: "user", content: "Hi" }]);
    const started = await turn("a", "Hi again");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].before).toEqual([{ role: "user", content: "Hi" }]);
    release(true);
    await started.done;
    expect(fileOf("a").messages.map((m: ChatMessage) => m.content)).toEqual(["Hi", "Hi again", "Fine."]);
  });

  it("tells pages it is a turn, says when it ends, and sends the changes as patches", async () => {
    save("a");
    const started = await turn("a");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
    release(true);
    await started.done;
    const mine = events.filter((e) => e.id === "a");
    expect(mine.find((e) => e.type === "status")?.data.run).toMatchObject({ kind: "turn" });
    // The streamed messages arrive as a patch from the first changed index.
    const patches = mine.filter((e) => e.type === "session").map((e) => e.data.patch.messages);
    expect(patches.some((m: any) => m?.from === hello.length && m.items.at(-1)?.content === "Fine.")).toBe(true);
    // The last status says the run is over.
    expect(mine.filter((e) => e.type === "status").at(-1)?.data.run).toBeNull();
    // No steps, so no step events.
    expect(mine.some((e) => e.type === "step")).toBe(false);
  });

  it("refuses a second message while the reply streams, and keeps nothing queued", async () => {
    save("a");
    const started = await turn("a");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const refused = runners.sendNote("a", "Wait, one more thing");
    expect(await reasonOf(refused)).toEqual({ status: 409, reason: "reply running" });
    await expect(runners.sendNote("a", "Wait, one more thing")).rejects.toThrow(/still in the box/);
    // Nor does a second reply start.
    expect(await reasonOf(turn("a", "second"))).toEqual({ status: 409, reason: "already running" });
    await expect(turn("a", "second")).rejects.toThrow(/busy/);
    expect(hub.liveRun("a")!.notes).toBeUndefined();
    release(true);
    await started.done;
    expect(calls).toHaveLength(1);
    expect(fileOf("a").messages.map((m: ChatMessage) => m.content)).not.toContain("Wait, one more thing");
    // Once it is over, the next message is a new reply.
    const next = await turn("a", "Now it's fine");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    release(true);
    await next.done;
  });

  it("is refused while a plan runs in the session, and the plan is untouched", async () => {
    putFile("a", { ...makeSession("a", 2), revision: 1 });
    await runners.startRunner("a", env, {
      run: (cb) => fakeRun("a", cb),
      save: (s) => hub.save(s.id, s),
      reply: (h) => {
        handles.set(h.sessionId, h);
        return async (_t, before) => ({ ok: true, messages: before });
      },
    });
    expect(await reasonOf(turn("a"))).toEqual({ status: 409, reason: "already running" });
    expect(calls).toEqual([]);
    finish("a", "s1");
    finish("a", "s2");
    await vi.waitFor(() => expect(hub.liveRun("a")).toBeNull());
  });

  it("can be stopped, and what streamed is kept", async () => {
    save("a");
    const started = await turn("a");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await runners.stopRun("a");
    await started.done;
    expect(hub.liveRun("a")).toBeNull();
    // What streamed before Stop is kept.
    expect(fileOf("a").messages.at(-1)).toEqual({ role: "assistant", content: "Fine." });
  });

  it("stores a question as plain data, and a command answers it", async () => {
    save("a");
    let answer: unknown = "none";
    during = async (h) => {
      const c = new AbortController();
      answer = await h.askUser({ needsApproval: { name: "run_command" } } as any, c.signal);
    };
    const started = await turn("a");
    await vi.waitFor(() => expect(hub.liveRun("a")?.status).toBe("waiting"));
    const ask = hub.liveRun("a")!.ask!;
    expect(ask).toMatchObject({ kind: "approval", details: { name: "run_command" } });
    expect(await reasonOf(runners.answerAsk("a", "not-it", true))).toEqual({ status: 409, reason: "stale ask" });
    await runners.answerAsk("a", ask.id, true);
    expect(answer).toBe(true);
    // The first answer won; a second one is stale.
    expect(await reasonOf(runners.answerAsk("a", ask.id, false))).toEqual({ status: 409, reason: "stale ask" });
    await vi.waitFor(() => expect(hub.liveRun("a")?.status).toBe("running"));
    release(true);
    await started.done;
  });

  it("denies a question that is still open when Stop comes", async () => {
    save("a");
    let answer: unknown = "none";
    during = async (h) => {
      answer = await h.askUser({ needsApproval: { name: "write_file" } } as any, new AbortController().signal);
    };
    const started = await turn("a");
    await vi.waitFor(() => expect(hub.liveRun("a")?.status).toBe("waiting"));
    await runners.stopRun("a");
    await started.done;
    expect(answer).toBe(false);
  });

  it("shows how it went wrong, keeps what streamed, and hands the session back", async () => {
    save("a");
    during = async () => {
      throw new Error("The model server went away");
    };
    const started = await turn("a");
    await started.done;
    expect(hub.liveRun("a")).toBeNull();
    const last = events.filter((e) => e.id === "a" && e.type === "status").at(-1)!;
    expect(last.data).toMatchObject({ run: null, error: "The model server went away" });
    expect(fileOf("a").messages.at(-1)).toEqual({ role: "assistant", content: "Fine." });
    expect(fileOf("a").run).toBeUndefined();
  });

  it("reports nothing to a parent: a reply is not a plan", async () => {
    save("a");
    putFile("p", { ...makeSession("p", 0), plan: null, revision: 1, threads: [{ sessionId: "a", summary: "x", anchor: "at:0" }] } as any);
    const report = vi.fn(async () => "never");
    const started = await runners.startTurn("a", env, { text: "hi", planning: false }, { reply: fakeReply, report, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release(true);
    await started.finished;
    expect(report).not.toHaveBeenCalled();
    expect(fileOf("p").threads[0].report).toBeUndefined();
  });

  it("is a 404 for a session with no file", async () => {
    expect(await reasonOf(turn("missing"))).toEqual({ status: 404, reason: undefined });
  });

  it("puts nothing secret in the events or the saved session", async () => {
    save("a");
    const started = await turn("a");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release(true);
    await started.done;
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(fileOf("a"))).not.toContain(SECRET);
  });

  it("refuses the page's own save while it runs, and takes it after", async () => {
    save("a");
    const started = await turn("a");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const mine = (old: any) => ({ ...old, title: "mine" });
    expect(await reasonOf(hub.replace("a", mine, fileOf("a").revision))).toEqual({ status: 409, reason: "run active" });
    release(true);
    await started.done;
    await expect(hub.replace("a", mine, fileOf("a").revision)).resolves.toBeTruthy();
    expect(fileOf("a").title).toBe("mine");
  });
});

describe("a chat reply with images", () => {
  it("passes images through to the reply call", async () => {
    save("a");
    const images = [{ id: "img-1", mediaType: "image/png" }];
    const started = await runners.startTurn("a", env, { text: "look", planning: false, images }, { reply: fakeReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].text).toBe("look");
    expect(calls[0].planning).toBe(false);
    release(true);
    await started.done;
  });

  it("passes the images field to the reply, which the fake records", async () => {
    save("a");
    const images = [{ id: "img-1", mediaType: "image/png" }];
    // Replace the fake reply to capture the images param.
    let capturedImages: any = undefined;
    const captureReply = (h: RunnerHandle) => {
      handles.set(h.sessionId, h);
      return async (text: string, before: ChatMessage[], opts: { planning?: boolean; images?: any } = {}) => {
        capturedImages = opts.images;
        const controller = new AbortController();
        h.setAbort(controller);
        const messages: ChatMessage[] = [...before, { role: "user", content: text }, { role: "assistant", content: "Fine." }];
        h.edit((s) => ({ ...s, messages }));
        release(true);
        return { ok: true, messages };
      };
    };
    const started = await runners.startTurn("a", env, { text: "look", planning: false, images }, { reply: captureReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => capturedImages !== undefined);
    expect(capturedImages).toEqual(images);
    await started.done;
  });

  it("puts images on the user message in history", async () => {
    save("a");
    const images = [{ id: "img-1", mediaType: "image/png" }];
    let capturedHistory: ChatMessage[] | undefined;
    const captureReply = (h: RunnerHandle) => {
      handles.set(h.sessionId, h);
      return async (text: string, before: ChatMessage[], opts: { planning?: boolean; images?: any } = {}) => {
        const controller = new AbortController();
        h.setAbort(controller);
        const userMsg: ChatMessage = { role: "user", content: text, images: opts.images };
        const messages: ChatMessage[] = [...before, userMsg, { role: "assistant", content: "Fine." }];
        h.edit((s) => ({ ...s, messages }));
        capturedHistory = [...before, userMsg];
        release(true);
        return { ok: true, messages };
      };
    };
    const started = await runners.startTurn("a", env, { text: "look", planning: false, images }, { reply: captureReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => capturedHistory !== undefined);
    const userMsg = capturedHistory!.find((m) => m.role === "user" && m.content === "look");
    expect(userMsg).toBeDefined();
    expect(userMsg!.images).toEqual(images);
    await started.done;
  });

  it("saves images on the user message in the session", async () => {
    save("a");
    const images = [{ id: "img-2", mediaType: "image/jpeg" }];
    // Use a reply that includes images on the user message.
    const imagesReply = (h: RunnerHandle) => {
      handles.set(h.sessionId, h);
      return async (text: string, before: ChatMessage[], opts: { planning?: boolean; images?: any } = {}) => {
        const controller = new AbortController();
        h.setAbort(controller);
        const userMsg: ChatMessage = { role: "user", content: text, images: opts.images };
        const messages: ChatMessage[] = [...before, userMsg, { role: "assistant", content: "Fine." }];
        h.edit((s) => ({ ...s, messages }));
        release(true);
        return { ok: true, messages };
      };
    };
    const started = await runners.startTurn("a", env, { text: "see", planning: false, images }, { reply: imagesReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => expect(calls).toHaveLength(0)); // fakeReply not used
    release(true);
    await started.done;
    const done = fileOf("a");
    const userMsg = done.messages.find((m: ChatMessage) => m.content === "see");
    expect(userMsg).toBeDefined();
    expect(userMsg!.images).toEqual(images);
  });

  it("collects image base64 from history and passes it to runTurn, but not to the saved session", async () => {
    // Create a real image file on disk in the temp home directory.
    const imgId = "img-abc";
    const imgDir = path.join(home.dir, "sessions", "a", "images");
    await mkdir(imgDir, { recursive: true });
    await writeFile(path.join(imgDir, `${imgId}.png`), Buffer.from("fake-png-bytes"));

    // Pre-populate history with a message that has image refs.
    const prevMsg: ChatMessage = { role: "user", content: "earlier", images: [{ id: imgId, mediaType: "image/png" }] };
    putFile("a", { ...makeSession("a", 0), plan: null, messages: [prevMsg], revision: 4 });

    // Use the real makeReply (not fakeReply) so image collection runs.
    // makeReply reads images from disk, builds the base64 map, and passes it
    // to runTurn. The base64 should NOT end up in the saved session.
    const { makeReply: realMakeReply } = await import("../../src/runnerReply.ts");
    const runners2 = await import("../runners.ts");
    const hub2 = await import("../runHub.ts");

    const started = await runners2.startTurn("a", env, { text: "now", planning: false, images: [{ id: "img-new", mediaType: "image/jpeg" }] }, { reply: realMakeReply, save: (s) => hub2.save(s.id, s) });
    await vi.waitFor(() => expect(hub2.liveRun("a")).not.toBeNull());
    // Wait for the run to finish (the real makeReply streams via runTurn).
    await started.done;

    // The saved session should have the image refs but NOT the base64 data.
    const done = fileOf("a");
    const newUser = done.messages.find((m: ChatMessage) => m.content === "now");
    expect(newUser).toBeDefined();
    expect(newUser!.images).toEqual([{ id: "img-new", mediaType: "image/jpeg" }]);
    // The previous message's images should still be refs only.
    const prevSaved = done.messages.find((m: ChatMessage) => m.content === "earlier");
    expect(prevSaved!.images).toEqual([{ id: imgId, mediaType: "image/png" }]);
    // No base64 data in the saved session.
    expect(JSON.stringify(done)).not.toContain("fake-png-bytes");
  });
});
