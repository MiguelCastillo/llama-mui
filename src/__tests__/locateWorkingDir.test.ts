import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";

const { mockStream, mockRunTool } = vi.hoisted(() => ({ mockStream: vi.fn(), mockRunTool: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool };
});

import { runTurn } from "../agent/agent";

// The model calls locate_path, the user answers, the model calls run_command.
// The model and the tool server are mocks; what's checked is what the turn does
// with the answer: the working directory, the attachments, the asks it makes and
// the text the model is told.

const locate = { id: "c1", name: "locate_path", arguments: JSON.stringify({ description: "the project", kind: "folder" }) };
const run = { id: "c2", name: "run_command", arguments: JSON.stringify({ command: "ls" }) };
const ASK = { needsLocation: { description: "the project", kind: "folder" } };

function setup(workingDir: string | null, answer: unknown) {
  const calls: { name: string; workingDir: string | null }[] = [];
  mockStream
    .mockResolvedValueOnce({ toolCalls: [locate], usage: undefined })
    .mockResolvedValueOnce({ toolCalls: [run], usage: undefined })
    .mockResolvedValue({ toolCalls: [], usage: undefined });
  mockRunTool.mockImplementation(async (call: any, ctx: any) => {
    calls.push({ name: call.name, workingDir: ctx.workingDir });
    return call.name === "locate_path" ? ASK : { result: "done" };
  });
  const asks: unknown[] = [];
  const attached: unknown[] = [];
  const dirs: string[] = [];
  const cb: Partial<RunTurnCallbacks> = {
    setMessages: () => {},
    setError: () => {},
    setFailed: () => {},
    setUsage: () => {},
    setAbort: () => {},
    refreshModels: () => {},
    askUser: async (ask: any) => {
      asks.push(ask);
      return answer as any;
    },
    attach: (a) => attached.push(a),
    setWorkingDir: (p) => dirs.push(p),
    todosRef: { current: [] },
    planRef: { current: null },
    planRunningRef: { current: false },
    planAnchor: null,
    planContext: null,
    planSummary: null,
  };
  const config: RunTurnConfig = {
    connectorId: "c", model: "m", toolsOn: true, modelOptions: {}, planning: false,
    systemPrompt: "sys", toolDefinitions: [], toolContextUpdate: "", seenUpdate: "",
    history: [], forgotten: [], workingDir, attached: [], chatId: "a",
    controller: new AbortController(), started: 0, text: "go",
  };
  return { config, cb: cb as RunTurnCallbacks, calls, asks, attached, dirs };
}

const toolText = (messages: any[]) => messages.filter((m) => m.role === "tool").map((m) => m.content);

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset();
});

describe("a folder chosen for locate_path", () => {
  it("offers the working directory when the chat has none, and uses it for the rest of the reply", async () => {
    const t = setup(null, [{ path: "/proj", kind: "folder", asWorkingDir: true }]);
    const r = await runTurn(t.config, t.cb);
    expect(t.asks).toEqual([{ needsLocation: { ...ASK.needsLocation, canSetWorkingDir: true } }]);
    expect(t.dirs).toEqual(["/proj"]);
    expect(t.attached).toEqual([]);
    expect(r.attached).toEqual([]);
    // run_command, called later in the same reply, starts in the new folder.
    expect(t.calls).toEqual([
      { name: "locate_path", workingDir: null },
      { name: "run_command", workingDir: "/proj" },
    ]);
    expect(toolText(r.messages)[0]).toMatch(/\/proj and made it the working directory/);
  });

  it("attaches as before when the answer isn't flagged", async () => {
    const t = setup(null, [{ path: "/proj", kind: "folder" }]);
    const r = await runTurn(t.config, t.cb);
    expect(t.dirs).toEqual([]);
    expect(t.attached).toEqual([{ path: "/proj", kind: "folder", source: "request" }]);
    expect(r.attached).toEqual(["/proj"]);
    expect(t.calls[1].workingDir).toBeNull();
    expect(toolText(r.messages)[0]).toMatch(/attached to this chat/);
  });

  it("offers no checkbox and changes nothing when the chat already has a working directory", async () => {
    const t = setup("/work", [{ path: "/proj", kind: "folder", asWorkingDir: true }]);
    const r = await runTurn(t.config, t.cb);
    expect(t.asks).toEqual([{ needsLocation: ASK.needsLocation }]);
    expect(t.dirs).toEqual([]);
    expect(t.attached).toEqual([{ path: "/proj", kind: "folder", source: "request" }]);
    expect(t.calls.every((c) => c.workingDir === "/work")).toBe(true);
    expect(r.attached).toEqual(["/proj"]);
  });

  it("never makes a file the working directory", async () => {
    const t = setup(null, [{ path: "/n.txt", kind: "file", asWorkingDir: true }]);
    await runTurn(t.config, t.cb);
    expect(t.dirs).toEqual([]);
    expect(t.attached).toEqual([{ path: "/n.txt", kind: "file", source: "request" }]);
  });
});
