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

// Spy on streamChat so we can inspect what it receives without a real server.
const streamChatSpy = vi.fn().mockResolvedValue({ toolCalls: [], usage: { contextTokens: 10, promptTokens: 5 } as any });
vi.mock("../../src/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api.ts")>();
  return {
    ...actual,
    streamChat: streamChatSpy,
    closeOpenToolCalls: actual.closeOpenToolCalls,
  };
});

const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");

const SECRET = "sk-secret-key";
const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true, apiKey: SECRET } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  thinkOn: false,
} as RunnerEnv;

let events: any[] = [];
let unsubscribe = () => {};

beforeEach(() => {
  resetFakes();
  streamChatSpy.mockClear();
  events = [];
  unsubscribe = hub.subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  await runners.resetRunners();
  files.clear();
});

describe("image base64 collection in makeReply", () => {
  it("passes the collected base64 map to streamChat, and a missing file is skipped", async () => {
    // Create one real image file, leave another referenced file missing.
    // Use UUID-format ids to match server/images.ts validation.
    const presentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const missingId = "11111111-2222-3333-4444-555555555555";
    // sessionsDir adds .llama-mui to the home dir, so files go there.
    const imgDir = path.join(home.dir, ".llama-mui", "sessions", "b", "images");
    await mkdir(imgDir, { recursive: true });
    await writeFile(path.join(imgDir, `${presentId}.png`), Buffer.from("present-bytes"));

    // Verify file exists on disk
    const fs = await import("node:fs/promises");
    const dirContents = await fs.readdir(imgDir);
    expect(dirContents).toContain(`${presentId}.png`);

    // History with two image refs: one on disk, one not.
    const prevMsg: ChatMessage = {
      role: "user",
      content: "earlier",
      images: [
        { id: presentId, mediaType: "image/png" },
        { id: missingId, mediaType: "image/png" },
      ],
    };
    putFile("b", { ...makeSession("b", 0), plan: null, messages: [prevMsg], revision: 4 });

    // Use the real makeReply so image collection runs.
    const { makeReply: realMakeReply } = await import("../../src/runnerReply.ts");

    const started = await runners.startTurn("b", env, { text: "now", planning: false }, { reply: realMakeReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => expect(streamChatSpy).toHaveBeenCalled());
    await started.done;

    // streamChat should have been called with the base64 data for the present image
    // but NOT for the missing one.
    const callArgs = streamChatSpy.mock.calls[0][0] as any;
    expect(callArgs.images).toBeDefined();
    expect(Object.keys(callArgs.images!)).toHaveLength(1);
    expect(callArgs.images![presentId]).toBe(Buffer.from("present-bytes").toString("base64"));
    expect(callArgs.images![missingId]).toBeUndefined();

    // The history messages should include the earlier message with image refs.
    const messages = callArgs.messages as ChatMessage[];
    const earlierMsg = messages.find((m: ChatMessage) => m.content === "earlier");
    expect(earlierMsg).toBeDefined();
    expect(earlierMsg!.images).toEqual([
      { id: presentId, mediaType: "image/png" },
      { id: missingId, mediaType: "image/png" },
    ]);
  });

  it("passes base64 for all images from history to streamChat", async () => {
    // Create two real image files with UUID-format ids.
    const img1Id = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
    const img2Id = "aaaaaaaa-bbbb-cccc-dddd-222222222222";
    const imgDir = path.join(home.dir, ".llama-mui", "sessions", "c", "images");
    await mkdir(imgDir, { recursive: true });
    await writeFile(path.join(imgDir, `${img1Id}.png`), Buffer.from("bytes-1"));
    await writeFile(path.join(imgDir, `${img2Id}.jpeg`), Buffer.from("bytes-2"));

    // History with two messages each carrying image refs.
    const msg1: ChatMessage = {
      role: "user",
      content: "first",
      images: [{ id: img1Id, mediaType: "image/png" }],
    };
    const msg2: ChatMessage = {
      role: "user",
      content: "second",
      images: [{ id: img2Id, mediaType: "image/jpeg" }],
    };
    putFile("c", { ...makeSession("c", 0), plan: null, messages: [msg1, msg2], revision: 4 });

    const { makeReply: realMakeReply } = await import("../../src/runnerReply.ts");

    const started = await runners.startTurn("c", env, { text: "now", planning: false }, { reply: realMakeReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => expect(streamChatSpy).toHaveBeenCalled());
    await started.done;

    const callArgs = streamChatSpy.mock.calls[0][0] as any;
    expect(callArgs.images).toBeDefined();
    expect(Object.keys(callArgs.images!)).toHaveLength(2);
    expect(callArgs.images![img1Id]).toBe(Buffer.from("bytes-1").toString("base64"));
    expect(callArgs.images![img2Id]).toBe(Buffer.from("bytes-2").toString("base64"));
  });

  it("passes base64 for an image attached to the message being sent (history has none)", async () => {
    const newId = "aaaaaaaa-bbbb-cccc-dddd-444444444444";
    const imgDir = path.join(home.dir, ".llama-mui", "sessions", "e", "images");
    await mkdir(imgDir, { recursive: true });
    await writeFile(path.join(imgDir, `${newId}.png`), Buffer.from("new-bytes"));

    putFile("e", { ...makeSession("e", 0), plan: null, messages: [], revision: 4 });

    const { makeReply: realMakeReply } = await import("../../src/runnerReply.ts");

    const started = await runners.startTurn(
      "e",
      env,
      { text: "look", planning: false, images: [{ id: newId, mediaType: "image/png" }] },
      { reply: realMakeReply, save: (s) => hub.save(s.id, s) },
    );
    await vi.waitFor(() => expect(streamChatSpy).toHaveBeenCalled());
    await started.done;

    const callArgs = streamChatSpy.mock.calls[0][0] as any;
    expect(callArgs.images).toBeDefined();
    expect(callArgs.images![newId]).toBe(Buffer.from("new-bytes").toString("base64"));

    // The ref is saved with the message, the bytes are not.
    const done = fileOf("e");
    const sent = done.messages.find((m: ChatMessage) => m.content === "look");
    expect(sent.images).toEqual([{ id: newId, mediaType: "image/png" }]);
    expect(JSON.stringify(done)).not.toContain(Buffer.from("new-bytes").toString("base64"));
  });

  it("leaves a missing file for the new message undefined, without throwing", async () => {
    const missingId = "aaaaaaaa-bbbb-cccc-dddd-555555555555";
    putFile("f", { ...makeSession("f", 0), plan: null, messages: [], revision: 4 });

    const { makeReply: realMakeReply } = await import("../../src/runnerReply.ts");

    const started = await runners.startTurn(
      "f",
      env,
      { text: "look", planning: false, images: [{ id: missingId, mediaType: "image/png" }] },
      { reply: realMakeReply, save: (s) => hub.save(s.id, s) },
    );
    await vi.waitFor(() => expect(streamChatSpy).toHaveBeenCalled());
    await started.done; // rejects if the missing file broke the reply

    const callArgs = streamChatSpy.mock.calls[0][0] as any;
    expect(callArgs.images?.[missingId]).toBeUndefined();
  });

  it("does not include base64 in the saved session or events", async () => {
    const imgId = "aaaaaaaa-bbbb-cccc-dddd-333333333333";
    const imgDir = path.join(home.dir, ".llama-mui", "sessions", "d", "images");
    await mkdir(imgDir, { recursive: true });
    await writeFile(path.join(imgDir, `${imgId}.png`), Buffer.from("secret-base64-data"));

    const prevMsg: ChatMessage = {
      role: "user",
      content: "earlier",
      images: [{ id: imgId, mediaType: "image/png" }],
    };
    putFile("d", { ...makeSession("d", 0), plan: null, messages: [prevMsg], revision: 4 });

    const { makeReply: realMakeReply } = await import("../../src/runnerReply.ts");

    const started = await runners.startTurn("d", env, { text: "now", planning: false }, { reply: realMakeReply, save: (s) => hub.save(s.id, s) });
    await vi.waitFor(() => expect(streamChatSpy).toHaveBeenCalled());
    await started.done;

    // The saved session should have image refs but NOT base64.
    const done = fileOf("d");
    const newUser = done.messages.find((m: ChatMessage) => m.content === "now");
    expect(newUser).toBeDefined();
    expect(newUser.images).toBeUndefined(); // text only, no images param passed
    expect(JSON.stringify(done)).not.toContain("secret-base64-data");

    // Events should also not contain the base64 data.
    const eventsJson = JSON.stringify(events);
    expect(eventsJson).not.toContain("secret-base64-data");
  });
});
