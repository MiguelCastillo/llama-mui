import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Session } from "../api";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";
import type { RunnerEnv } from "../runnerTypes";

const { mockStream, mockRunTool, mockRunTurn, mockListModels } = vi.hoisted(() => ({
  mockStream: vi.fn(),
  mockRunTool: vi.fn(),
  mockRunTurn: vi.fn(),
  mockListModels: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool, listModels: mockListModels };
});

// Both levels in one file: the real reply loop (runTurn) with streamChat
// mocked, and the real reply builder (makeReply) with runTurn mocked. The loop is
// imported before runTurn is mocked below, through a second path.
const real = await vi.importActual<typeof import("../agent/agent")>("../agent/agent");
vi.mock("../agent/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/agent")>();
  return { ...actual, runTurn: mockRunTurn };
});
vi.mock("../agent/sessionNaming", () => ({ askForSessionName: vi.fn().mockResolvedValue(null) }));

import { makeReply } from "../runnerReply";

// The cache. Anthropic and llama.cpp reuse their work on a request only up to the
// first thing that differs from the request before it. A compaction summary is
// asked for right after a reply, and is only cheap if its request starts
// exactly like that reply's last request: the same system prompt, tools and
// settings, then the same messages, then the new ones. These tests catch a code
// change that would break that without calling Anthropic. (Measured once for
// real on 2026-11-14: the summary request read all 21,038 tokens of the chat
// from the cache and wrote only the 187 of the request itself.)

const REQUEST = "Please write a summary of our conversation so far.";
const tools = [{ name: "read_file" }, { name: "write_file" }];

// What reaches the wire for a message: the fields a request is made from.
const wire = (m: ChatMessage) => ({
  role: m.role,
  content: m.content,
  toolCalls: m.toolCalls,
  toolCallId: m.toolCallId,
  blocks: m.blocks,
  images: m.images,
  update: m.update,
  note: m.note,
});

function loopConfig(history: ChatMessage[], text: string, extra: Partial<RunTurnConfig> = {}): RunTurnConfig {
  return {
    connectorId: "c", kind: "anthropic", api: "anthropic", model: "m", toolsOn: true, modelOptions: { effort: "high" } as any,
    planning: false, systemPrompt: "sys", toolDefinitions: tools, toolContextUpdate: "ctx", seenUpdate: "ctx",
    history, forgotten: [], workingDir: "/work", attached: ["/docs"], chatId: "a",
    controller: new AbortController(), started: 0, text, clearCount: 0, ...extra,
  };
}

const callbacks = (): RunTurnCallbacks =>
  ({
    setMessages: () => {}, setError: () => {}, setFailed: () => {}, setUsage: () => {}, setAbort: () => {}, refreshModels: () => {},
    askUser: async () => true, todosRef: { current: [] }, planRef: { current: null }, planRunningRef: { current: false },
    planAnchor: null, planContext: null, planSummary: null,
  }) as unknown as RunTurnCallbacks;

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset();
  mockRunTurn.mockReset();
  mockListModels.mockReset().mockResolvedValue([{ id: "m", status: "loaded" }]);
});

describe("what the reply loop sends for a compaction", () => {
  it("starts exactly like the request before it, then adds the reply and the request for the summary", async () => {
    mockStream.mockImplementation(async (_req: any, onDelta: any) => {
      onDelta({ content: "Done." });
      return { toolCalls: [], usage: undefined };
    });
    const earlier: ChatMessage[] = [{ role: "user", content: "first" }, { role: "assistant", content: "ok" }];
    const first = await real.runTurn(loopConfig(earlier, "And now?"), callbacks());
    const compact = await real.runTurn(loopConfig(first.messages, REQUEST, { compact: true }), callbacks());
    expect(compact.messages.at(-1)).toMatchObject({ role: "assistant", compaction: true });

    const [a, b] = [mockStream.mock.calls[0][0], mockStream.mock.calls[1][0]];
    // Same everything but the messages.
    for (const key of ["connectorId", "kind", "api", "model", "options", "tools", "clearCount", "images"]) {
      expect(b[key], key).toEqual(a[key]);
    }
    expect(b.purpose).toEqual(a.purpose);
    // The same messages first, in the same order.
    expect(b.messages.slice(0, a.messages.length).map(wire)).toEqual(a.messages.map(wire));
    // Then the reply to the last message, then the request for the summary, and nothing else.
    expect(b.messages.length).toBe(a.messages.length + 2);
    expect(b.messages.at(-2)).toMatchObject({ role: "assistant", content: "Done." });
    expect(b.messages.at(-1)).toMatchObject({ role: "user", content: REQUEST });
    expect(b.tools).toEqual(tools);
  });
});

describe("what the reply builder gives the reply loop for a compaction", () => {
  const env = {
    connector: { id: "c", kind: "anthropic", api: "anthropic" } as any,
    model: "m",
    models: [],
    toolContext: { definitions: tools, checkCommands: {}, systemPrompt: "sys", update: "ctx" } as any,
    toolsOn: true,
    modelOptions: { effort: "high" } as any,
  } as RunnerEnv;

  function handle(messages: ChatMessage[]) {
    let session: Session = {
      id: "a", title: "a", model: "m", messages, contextStart: 0, workingDir: "/work",
      attachments: [{ path: "/docs", kind: "folder", source: "user" } as any], usage: null, failed: null, plan: null,
    } as Session;
    return {
      sessionId: "a",
      env,
      getSession: () => session,
      edit: (fn: (s: Session) => Session) => {
        session = fn(session);
      },
      setError: () => {},
      setAbort: () => {},
      askUser: vi.fn(),
      planRunningRef: { current: false },
      planRef: { current: null },
    } as any;
  }

  it("is the same request as the turn before it, in everything but the message", async () => {
    mockRunTurn.mockImplementation(async (config: RunTurnConfig) => ({
      ok: true,
      messages: [...config.forgotten, ...config.history, { role: "user", content: config.text }, { role: "assistant", content: "ok" }],
      attached: config.attached,
    }));
    const h = handle([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
    const reply = makeReply(h);
    const turn = await reply("hello", h.getSession().messages, {});
    await reply(REQUEST, turn.messages, { compact: true });

    const [a, b] = [mockRunTurn.mock.calls[0][0] as RunTurnConfig, mockRunTurn.mock.calls[1][0] as RunTurnConfig];
    for (const key of [
      "connectorId", "kind", "api", "model", "toolsOn", "modelOptions", "planning", "systemPrompt", "toolDefinitions",
      "toolContextUpdate", "seenUpdate", "forgotten", "workingDir", "attached", "chatId", "clearCount",
    ] as const) {
      expect(b[key], key).toEqual(a[key]);
    }
    // The history is the first turn's, plus that turn's message and reply.
    expect(b.history.slice(0, a.history.length)).toEqual(a.history);
    expect(b.history.length).toBe(a.history.length + 2);
    expect(b.compact).toBe(true);
    expect(a).not.toHaveProperty("compact");
  });
});
