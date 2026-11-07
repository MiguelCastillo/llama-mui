import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";

const { mockStream, mockRunTool } = vi.hoisted(() => ({ mockStream: vi.fn(), mockRunTool: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool };
});

import { runTurn } from "../agent/agent";
import { SAME_OUTPUT_LIMIT } from "../agent/progress";

// The model and the tool server are mocks. What's checked is when a reply is
// stopped for being stuck, and when a long reply is left alone.

function setup() {
  const errors: (string | null)[] = [];
  const cb: Partial<RunTurnCallbacks> = {
    setMessages: () => {},
    setError: (e) => errors.push(e),
    setFailed: () => {},
    setUsage: () => {},
    setAbort: () => {},
    refreshModels: () => {},
    askUser: async () => true,
    attach: () => {},
    setWorkingDir: () => {},
    todosRef: { current: [] },
    planRef: { current: null },
    planRunningRef: { current: false },
    planAnchor: null,
    planContext: null,
    planSummary: null,
  };
  const config: RunTurnConfig = {
    connectorId: "c", model: "m", toolsOn: true, thinkOn: false, planning: false,
    systemPrompt: "sys", toolDefinitions: [], toolContextUpdate: "", seenUpdate: "",
    history: [], forgotten: [], workingDir: "/w", attached: [], chatId: "a",
    controller: new AbortController(), started: 0, text: "go",
  };
  return { config, cb: cb as RunTurnCallbacks, errors };
}

const runCall = (i: number, command: string) => ({ id: `r${i}`, name: "run_command", arguments: JSON.stringify({ command }) });

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset();
});

describe("a reply that is stuck", () => {
  it("stops when the same output keeps coming back whatever the command, with a last request that has no tools", async () => {
    let i = 0;
    // A different command each time (a comment on the end), the same failure each time.
    mockStream.mockImplementation(async (req: any) => (req.tools ? { toolCalls: [runCall(++i, `npx vitest run # ${i}`)], usage: undefined } : { toolCalls: [], usage: undefined }));
    mockRunTool.mockResolvedValue({ result: "FAIL x\nError: expected undefined to be defined" });
    const t = setup();
    const r = await runTurn(t.config, t.cb);
    expect(r.ok).toBe(false);
    expect(t.errors.at(-1)).toMatch(/^Stopped: the last 4 commands all gave the same output/);
    // Four rounds, then one more request, with no tools, to say what it has.
    expect(i).toBe(SAME_OUTPUT_LIMIT);
  });

  it("stops the same way when the results are what the server really prints, with the command on top", async () => {
    let i = 0;
    mockStream.mockImplementation(async (req: any) => (req.tools ? { toolCalls: [runCall(++i, `npx vitest run # ${i}`)], usage: undefined } : { toolCalls: [], usage: undefined }));
    mockRunTool.mockImplementation(async (call: any) => ({ result: `$ ${JSON.parse(call.arguments).command}\nFAIL x\nError: expected undefined to be defined\n[exit code 1]` }));
    const t = setup();
    const r = await runTurn(t.config, t.cb);
    expect(r.ok).toBe(false);
    expect(t.errors.at(-1)).toMatch(/^Stopped: the last 4 commands all gave the same output/);
    expect(i).toBe(SAME_OUTPUT_LIMIT);
  });

  it("keeps the system prompt on the last request, which has no tools", async () => {
    let i = 0;
    const requests: any[] = [];
    mockStream.mockImplementation(async (req: any) => {
      requests.push(req);
      return req.tools ? { toolCalls: [runCall(++i, `npx vitest run # ${i}`)], usage: undefined } : { toolCalls: [], usage: undefined };
    });
    mockRunTool.mockResolvedValue({ result: "FAIL x\nError: expected undefined to be defined" });
    const t = setup();
    t.config.toolDefinitions = [{ type: "function", function: { name: "run_command" } }];
    await runTurn(t.config, t.cb);
    const last = requests.at(-1);
    expect(last.tools).toBeUndefined();
    expect(last.messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("stops on the same command giving the same output", async () => {
    let i = 0;
    mockStream.mockImplementation(async (req: any) => (req.tools ? { toolCalls: [runCall(++i, "npx vitest run")], usage: undefined } : { toolCalls: [], usage: undefined }));
    // An edit in between each (so the repeat guard, which an edit resets, never sees three identical calls).
    mockRunTool.mockImplementation(async () => ({ result: "FAIL x\nError: expected undefined to be defined" }));
    const t = setup();
    const r = await runTurn(t.config, t.cb);
    expect(r.ok).toBe(false);
    expect(t.errors.at(-1)).toMatch(/Stopped/);
    expect(i).toBeLessThanOrEqual(SAME_OUTPUT_LIMIT + 1);
  });
});

describe("a long reply that keeps getting somewhere", () => {
  it("is not stopped after 50 rounds", async () => {
    let i = 0;
    mockStream.mockImplementation(async (req: any) => {
      if (!req.tools) return { toolCalls: [], usage: undefined };
      i++;
      return i > 80 ? { toolCalls: [], usage: undefined } : { toolCalls: [runCall(i, `npx vitest run # ${i}`)], usage: undefined };
    });
    // Every result is different: the number of failures goes down, then it passes.
    mockRunTool.mockImplementation(async (call: any) => ({ result: `Error: expected undefined to be defined\nTests  ${100 - Number(JSON.parse(call.arguments).command.split("# ")[1])} failed` }));
    const t = setup();
    const r = await runTurn(t.config, t.cb);
    expect(r.ok).toBe(true);
    expect(i).toBeGreaterThan(80);
    expect(t.errors.filter(Boolean)).toEqual([]);
  });
});
