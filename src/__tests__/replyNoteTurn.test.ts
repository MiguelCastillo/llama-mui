import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";

const { mockStream, mockRunTool } = vi.hoisted(() => ({ mockStream: vi.fn(), mockRunTool: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool };
});

import { runTurn, shouldBlockRepeat, recordCall } from "../agent/agent";

const idea = (id: string, text: string) => ({ id, name: "add_idea", arguments: JSON.stringify({ text }) });
const action = (id: string, text: string, can_do?: boolean) => ({ id, name: "add_action_item", arguments: JSON.stringify({ text, can_do }) });

function setup(planning = true) {
  mockRunTool.mockResolvedValue({ result: "Shown to the user." });
  const cb: Partial<RunTurnCallbacks> = {
    setMessages: () => {}, setError: () => {}, setFailed: () => {}, setUsage: () => {}, setAbort: () => {},
    refreshModels: () => {}, askUser: async () => true,
    todosRef: { current: [] }, planRef: { current: null }, planRunningRef: { current: false },
    planAnchor: null, planContext: null, planSummary: null,
  };
  const config: RunTurnConfig = {
    connectorId: "c", model: "m", toolsOn: true, thinkOn: false, planning,
    systemPrompt: "sys", toolDefinitions: [], toolContextUpdate: "", seenUpdate: "",
    history: [], forgotten: [], workingDir: "/work", attached: [], chatId: "a",
    controller: new AbortController(), started: 0, text: "hi",
  };
  return { config, cb: cb as RunTurnCallbacks };
}

const assistants = (messages: any[]) => messages.filter((m) => m.role === "assistant");

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset();
});

describe("ideas and action items in a turn", () => {
  it("records them on the reply and ends the turn after the round", async () => {
    mockStream.mockResolvedValueOnce({ toolCalls: [idea("i1", " Try X "), action("a1", "Restart it", true)], usage: undefined });
    const t = setup();
    const r = await runTurn(t.config, t.cb);
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    const [reply] = assistants(r.messages);
    expect(reply.notes).toEqual([
      { kind: "idea", text: "Try X" },
      { kind: "action", text: "Restart it", canDo: true },
    ]);
    expect(reply.toolCalls).toHaveLength(2);
    expect(r.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("keeps at most two ideas", async () => {
    mockStream.mockResolvedValueOnce({ toolCalls: [idea("1", "a"), idea("2", "b"), idea("3", "c")], usage: undefined });
    const t = setup();
    const r = await runTurn(t.config, t.cb);
    expect(assistants(r.messages)[0].notes.map((n: any) => n.text)).toEqual(["a", "b"]);
  });

  it("does not stop the model for sending the same note many times in a reply", async () => {
    const same = [1, 2, 3, 4, 5, 6].map((i) => action(`a${i}`, "Same thing"));
    mockStream.mockResolvedValueOnce({ toolCalls: same, usage: undefined });
    const t = setup();
    const r = await runTurn(t.config, t.cb);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.messages.filter((m) => m.role === "tool").every((m) => m.content === "Shown to the user.")).toBe(true);
    expect(assistants(r.messages)[0].notes).toHaveLength(6);
  });

  it("goes on when the call was refused, and records nothing", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [idea("i1", "")], usage: undefined })
      .mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup();
    mockRunTool.mockResolvedValue({ result: "Error: text is required" });
    const r = await runTurn(t.config, t.cb);
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(assistants(r.messages)[0].notes).toBeUndefined();
  });

  it("does not end a turn that isn't a main-chat reply", async () => {
    mockStream
      .mockResolvedValueOnce({ toolCalls: [idea("i1", "x")], usage: undefined })
      .mockResolvedValue({ toolCalls: [], usage: undefined });
    const t = setup(false);
    await runTurn(t.config, t.cb);
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it("never counts them as repeats", async () => {
    const ran = new Map<string, number>();
    const c = { id: "x", name: "add_idea", arguments: '{"text":"same"}' };
    for (let i = 0; i < 10; i++) recordCall(ran, c);
    expect(ran.size).toBe(0);
    expect(shouldBlockRepeat(ran, c).blocked).toBe(false);
  });
});
