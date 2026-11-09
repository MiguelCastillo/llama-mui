import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/api.ts";
import type { RunnerEnv } from "../../src/runnerTypes.ts";
import { makeSession, resetFakes } from "./fakeRun.ts";
import { fileOf, files, putFile } from "./memorySessions.ts";

// A message that replies to an earlier response (replyTo): the saved user
// message carries the quote so the chat can show it, but what the model is
// sent is only the question. The real makeReply and toMessages run; only the
// request to the model server is a spy.

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});
vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original<object>()));

const streamChatSpy = vi.fn().mockResolvedValue({ toolCalls: [], usage: { contextTokens: 10, promptTokens: 5 } as any });
vi.mock("../../src/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api.ts")>();
  return { ...actual, streamChat: streamChatSpy };
});

const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");
const { toMessages } = await import("../../src/api.ts");
const { makeReply } = await import("../../src/runnerReply.ts");

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: false } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  thinkOn: false,
} as RunnerEnv;

const QUOTE = "Use a map, not a list, for lookups.";
const history: ChatMessage[] = [
  { role: "user", content: "How do I look things up?" },
  { role: "assistant", content: QUOTE },
];

beforeEach(() => {
  resetFakes();
  streamChatSpy.mockClear();
  putFile("a", { ...makeSession("a", 0), plan: null, messages: history, revision: 4 });
});

afterEach(async () => {
  await runners.resetRunners();
  files.clear();
});

const run = async (turn: { text: string; replyTo?: string }) => {
  const started = await runners.startTurn("a", env, { ...turn, planning: false }, { reply: makeReply, save: (s) => hub.save(s.id, s) });
  await vi.waitFor(() => expect(streamChatSpy).toHaveBeenCalled());
  await started.done;
};

describe("a message that replies to a response", () => {
  it("saves the quote on the user message, and the model's request has only the question", async () => {
    await run({ text: "Why a map?", replyTo: QUOTE });

    const saved = fileOf("a").messages.find((m: ChatMessage) => m.content === "Why a map?");
    expect(saved.replyTo).toEqual({ text: QUOTE });

    // What streamChat was given is turned into the request by toMessages: the
    // new message is there as the question, and the quote is only the earlier
    // response, once, in history.
    const sent = streamChatSpy.mock.calls[0][0] as any;
    const last = sent.messages.at(-1) as ChatMessage;
    const request = toMessages(sent.messages).messages;
    expect(request.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Why a map?" }] });
    expect(JSON.stringify(request).split(QUOTE)).toHaveLength(2);
    expect(last.content).toBe("Why a map?");
  });

  it("saves no replyTo on an ordinary message", async () => {
    await run({ text: "Thanks" });
    const saved = fileOf("a").messages.find((m: ChatMessage) => m.content === "Thanks");
    expect(saved).toBeDefined();
    expect(saved).not.toHaveProperty("replyTo");
  });
});
