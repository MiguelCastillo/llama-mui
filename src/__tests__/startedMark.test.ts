// A call that changes something is marked started and saved (flush) before its
// tool runs, and saved again after its result; a read triggers no flush.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";
import type { ChatMessage } from "../api";

const { mockStream, mockRunTool } = vi.hoisted(() => ({ mockStream: vi.fn(), mockRunTool: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool };
});

import { runTurn } from "../agent/agent";

const call = (id: string, name: string) => ({ id, name, arguments: "{}" });

let log: string[] = [];
let latest: ChatMessage[] = [];

function setup(flush?: () => Promise<void>) {
  const cb: Partial<RunTurnCallbacks> = {
    setMessages: (m) => void (latest = m), setError: () => {}, setFailed: () => {}, setUsage: () => {}, setAbort: () => {},
    refreshModels: () => {}, askUser: async () => true,
    todosRef: { current: [] }, planRef: { current: null }, planRunningRef: { current: false },
    planAnchor: null, planContext: null, planSummary: null,
    callEffect: (c) => (c.name === "read_file" ? "none" : "change"),
    flush,
  };
  const config: RunTurnConfig = {
    connectorId: "c", model: "m", toolsOn: true, modelOptions: {}, planning: false,
    systemPrompt: "sys", toolDefinitions: [], toolContextUpdate: "", seenUpdate: "",
    history: [], forgotten: [], workingDir: "/work", attached: [], chatId: "a",
    controller: new AbortController(), started: 0, text: "hi",
  };
  return { config, cb: cb as RunTurnCallbacks };
}

// A flush that takes a moment, and notes what the chat held when it began and
// whether each call carried the mark.
const slowFlush = () => {
  const marks = () => (latest.find((m) => m.role === "assistant")?.toolCalls ?? []).map((c) => `${c.id}:${c.started ? "started" : "plain"}`).join(",");
  return async () => {
    log.push(`flush-begin[${marks()}]`);
    await new Promise((r) => setTimeout(r, 15));
    log.push("flush-end");
  };
};

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset();
  log = [];
  latest = [];
  mockRunTool.mockImplementation(async (c: any) => {
    log.push(`run:${c.name}`);
    return { result: "done" };
  });
});

describe("started mark around a changing call", () => {
  it("runs the tool only after the flush that saved the mark has finished, and flushes again after the result", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [call("w1", "write_file")], usage: undefined })
      .mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup(slowFlush());
    const r = await runTurn(t.config, t.cb);
    expect(log).toEqual(["flush-begin[w1:started]", "flush-end", "run:write_file", "flush-begin[w1:started]", "flush-end"]);
    // The result is in the chat by the time of the second flush, and the mark stays.
    expect(r.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(r.messages.find((m) => m.role === "assistant")?.toolCalls?.[0].started).toBe(true);
  });

  it("a read triggers no flush and carries no mark", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [call("r1", "read_file")], usage: undefined })
      .mockResolvedValue({ toolCalls: [], usage: undefined });
    const flush = vi.fn(slowFlush());
    const t = setup(flush);
    const r = await runTurn(t.config, t.cb);
    expect(flush).not.toHaveBeenCalled();
    expect(log).toEqual(["run:read_file"]);
    expect(r.messages.find((m) => m.role === "assistant")?.toolCalls?.[0]).not.toHaveProperty("started");
  });

  it("marks and flushes each changing call of a round in turn, and not the read between them", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [call("a", "write_file"), call("b", "read_file"), call("c", "run_command")], usage: undefined })
      .mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup(slowFlush());
    await runTurn(t.config, t.cb);
    expect(log).toEqual([
      "flush-begin[a:started,b:plain,c:plain]", "flush-end", "run:write_file", "flush-begin[a:started,b:plain,c:plain]", "flush-end",
      "run:read_file",
      "flush-begin[a:started,b:plain,c:started]", "flush-end", "run:run_command", "flush-begin[a:started,b:plain,c:started]", "flush-end",
    ]);
  });

  it("without a flush (tests, the page) changing calls still run and get no mark", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [call("w1", "write_file")], usage: undefined })
      .mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup(undefined);
    const r = await runTurn(t.config, t.cb);
    expect(log).toEqual(["run:write_file"]);
    expect(r.messages.find((m) => m.role === "assistant")?.toolCalls?.[0]).not.toHaveProperty("started");
  });

  it("a failed flush before the tool stops the tool from running", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [call("w1", "write_file")], usage: undefined })
      .mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup(async () => {
      throw new Error("disk full");
    });
    const r = await runTurn(t.config, t.cb);
    expect(log).toEqual([]);
    expect(r.messages.find((m) => m.role === "tool")?.content).toMatch(/disk full/);
  });
});
