// Continue after a restart: the request to the model is built from the saved
// (settled) chat. No half reply, every call answered, and a call that never
// started is asked for again, with the approval prompt again.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";
import type { ChatMessage } from "../api";
import { NOT_STARTED_CALL } from "../closeOpenToolCalls";

const { mockStream, mockRunTool } = vi.hoisted(() => ({ mockStream: vi.fn(), mockRunTool: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool };
});

import { runTurn } from "../agent/agent";
import { markInterrupted } from "../../server/restart";

const call = { id: "w1", name: "write_file", arguments: JSON.stringify({ path: "/work/a.ts" }) };
const saved: ChatMessage[] = [
  { role: "user", content: "Build it" },
  { role: "assistant", content: "Writing the file.", toolCalls: [call], planStep: "s1" },
  { role: "assistant", content: "Then I will che" } as ChatMessage, // streamed when the app stopped
];

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset();
});

function setup(history: ChatMessage[], askUser: any) {
  const cb = {
    setMessages: () => {}, setError: () => {}, setFailed: () => {}, setUsage: () => {}, setAbort: () => {},
    refreshModels: () => {}, askUser,
    todosRef: { current: [] }, planRef: { current: null }, planRunningRef: { current: false },
    planAnchor: null, planContext: null, planSummary: null,
    callEffect: () => "change",
    flush: async () => {},
  } as unknown as RunTurnCallbacks;
  const config: RunTurnConfig = {
    connectorId: "c", model: "m", toolsOn: true, modelOptions: {}, planning: false, planStep: "s1",
    systemPrompt: "sys", toolDefinitions: [], toolContextUpdate: "", seenUpdate: "",
    history, forgotten: [], workingDir: "/work", attached: [], chatId: "a",
    controller: new AbortController(), started: 0, text: "Continue with step 1",
  };
  return { config, cb };
}

describe("Continue from a settled chat", () => {
  // The saved chat as the restart leaves it: the half reply is gone and the
  // unstarted call is closed.
  const settled = markInterrupted({ plan: null, messages: saved }, { status: "running", startedAt: 1, streaming: true, request: "reply", marksCalls: true } as any).messages as ChatMessage[];

  it("hands streamChat the saved chat with the call closed and the half reply marked (streamChat leaves it out)", async () => {
    mockStream.mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup(settled, async () => true);
    await runTurn(t.config, t.cb);
    const sent = mockStream.mock.calls[0][0].messages as ChatMessage[];
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
    expect(sent[4]).toMatchObject({ content: "Then I will che", cutOff: true });
    expect(sent[3]).toMatchObject({ role: "tool", toolCallId: "w1", content: NOT_STARTED_CALL });
    expect(sent[5].content).toBe("Continue with step 1");
    // Nothing was run by Continue itself.
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  it("when the model makes the call again, approval is asked for again before it runs", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [{ ...call, id: "w2" }], usage: undefined })
      .mockResolvedValue({ toolCalls: [], usage: undefined });
    mockRunTool.mockImplementation(async (_c: any, ctx: any) =>
      ctx.approved ? { result: "written" } : { needsApproval: { type: "change", path: "/work/a.ts", diff: "+x" } },
    );
    const askUser = vi.fn(async () => true);
    const t = setup(settled, askUser);
    const r = await runTurn(t.config, t.cb);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(mockRunTool).toHaveBeenCalledTimes(2);
    expect(r.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([NOT_STARTED_CALL, "written"]);
  });
});
