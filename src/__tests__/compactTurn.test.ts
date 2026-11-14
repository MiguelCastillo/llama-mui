import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";
import { COMPACT_REFUSAL } from "../compact";

const { mockStream, mockRunTool } = vi.hoisted(() => ({ mockStream: vi.fn(), mockRunTool: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool };
});

import { runTurn } from "../agent/agent";

// A turn that asks for a compaction summary (src/compact.ts): its messages carry
// `compaction`, the tools stay in the request (so it starts exactly as the last
// request did) but no tool runs.

const REQUEST = "Please write a summary of our conversation so far.";
const read = { id: "r1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) };
const tools = [{ name: "read_file" }, { name: "write_file" }];

function setup(compact: boolean) {
  const cb: Partial<RunTurnCallbacks> = {
    setMessages: () => {},
    setError: () => {},
    setFailed: () => {},
    setUsage: () => {},
    setAbort: () => {},
    refreshModels: () => {},
    askUser: async () => true,
    todosRef: { current: [] },
    planRef: { current: null },
    planRunningRef: { current: false },
    planAnchor: null,
    planContext: null,
    planSummary: null,
  };
  const config: RunTurnConfig = {
    connectorId: "c", model: "m", toolsOn: true, modelOptions: {}, planning: false,
    systemPrompt: "sys", toolDefinitions: tools, toolContextUpdate: "", seenUpdate: "",
    history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }],
    forgotten: [], workingDir: "/work", attached: [], chatId: "a",
    controller: new AbortController(), started: 0, text: REQUEST,
    ...(compact ? { compact: true } : {}),
  };
  return { config, cb: cb as RunTurnCallbacks };
}

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset().mockResolvedValue({ result: "file text" });
});

describe("a turn that asks for a compaction summary", () => {
  it("marks the request and the reply, and leaves the earlier messages alone", async () => {
    mockStream.mockResolvedValue({ toolCalls: [], usage: undefined });
    mockStream.mockImplementation(async (_req: any, onDelta: any) => {
      onDelta({ content: "The summary." });
      return { toolCalls: [], usage: undefined };
    });
    const t = setup(true);
    const r = await runTurn(t.config, t.cb);
    expect(r.messages[0]).not.toHaveProperty("compaction");
    expect(r.messages[1]).not.toHaveProperty("compaction");
    expect(r.messages[2]).toMatchObject({ role: "user", content: REQUEST, compaction: true });
    expect(r.messages[3]).toMatchObject({ role: "assistant", content: "The summary.", compaction: true });
  });

  it("sends the tool definitions anyway, so the request starts as the last one did", async () => {
    mockStream.mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup(true);
    await runTurn(t.config, t.cb);
    expect(mockStream.mock.calls[0][0].tools).toEqual(tools);
    expect(mockStream.mock.calls[0][0].messages[0]).toMatchObject({ role: "system", content: "sys" });
  });

  it("refuses a tool call without running it, and the model goes on to write the summary", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [read], usage: undefined })
      .mockImplementationOnce(async (_req: any, onDelta: any) => {
        onDelta({ content: "Written from what I know." });
        return { toolCalls: [], usage: undefined };
      });
    const t = setup(true);
    const r = await runTurn(t.config, t.cb);
    expect(mockRunTool).not.toHaveBeenCalled();
    const result = r.messages.find((m) => m.role === "tool");
    expect(result?.content).toContain(COMPACT_REFUSAL);
    expect(r.messages.at(-1)).toMatchObject({ role: "assistant", content: "Written from what I know.", compaction: true });
  });

  it("is an ordinary turn without the flag: nothing marked, tools run", async () => {
    mockStream.mockResolvedValueOnce({ toolCalls: [read], usage: undefined }).mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup(false);
    const r = await runTurn(t.config, t.cb);
    expect(mockRunTool).toHaveBeenCalledTimes(1);
    expect(r.messages.some((m) => m.compaction)).toBe(false);
  });
});
