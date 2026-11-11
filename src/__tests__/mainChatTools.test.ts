import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";

const { mockStream, mockRunTool } = vi.hoisted(() => ({ mockStream: vi.fn(), mockRunTool: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool };
});

import { runTurn } from "../agent/agent";

// A main-chat turn (planning on) no longer refuses write_file: the call goes to
// the tool server, and the approval it asks for reaches the user.

const write = { id: "w1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "hi" }) };
const APPROVAL = { needsApproval: { type: "change", path: "a.txt", diff: "+hi" } };

function setup(answer: boolean | "plan") {
  mockStream
    .mockResolvedValueOnce({ toolCalls: [write], usage: undefined })
    .mockResolvedValue({ toolCalls: [], usage: undefined });
  mockRunTool.mockImplementation(async (_call: any, ctx: any) =>
    ctx.approved ? { result: "Wrote a.txt" } : APPROVAL,
  );
  const asks: unknown[] = [];
  const cb: Partial<RunTurnCallbacks> = {
    setMessages: () => {},
    setError: () => {},
    setFailed: () => {},
    setUsage: () => {},
    setAbort: () => {},
    refreshModels: () => {},
    askUser: async (ask: any) => {
      asks.push(ask);
      return answer;
    },
    todosRef: { current: [] },
    planRef: { current: null },
    planRunningRef: { current: false },
    planAnchor: null,
    planContext: null,
    planSummary: null,
  };
  const config: RunTurnConfig = {
    connectorId: "c", model: "m", toolsOn: true, modelOptions: {}, planning: true,
    systemPrompt: "sys", toolDefinitions: [], toolContextUpdate: "", seenUpdate: "",
    history: [], forgotten: [], workingDir: "/work", attached: [], chatId: "a",
    controller: new AbortController(), started: 0, text: "make a.txt",
  };
  return { config, cb: cb as RunTurnCallbacks, asks };
}

const toolText = (messages: any[]) => messages.filter((m) => m.role === "tool").map((m) => m.content);

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset();
});

describe("write_file in a main-chat turn", () => {
  it("reaches the approval prompt, and runs once approved", async () => {
    const t = setup(true);
    const r = await runTurn(t.config, t.cb);
    expect(t.asks).toEqual([APPROVAL]);
    expect(toolText(r.messages)).toEqual(["Wrote a.txt"]);
  });

  it("is not written when the user denies it", async () => {
    const t = setup(false);
    const r = await runTurn(t.config, t.cb);
    expect(t.asks).toEqual([APPROVAL]);
    expect(toolText(r.messages)[0]).toMatch(/didn't approve this change to a\.txt/);
    expect(toolText(r.messages)[0]).not.toMatch(/isn't available while planning/);
  });
});
