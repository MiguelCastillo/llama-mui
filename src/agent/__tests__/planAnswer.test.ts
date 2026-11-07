import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent";

const { mockStream, mockRunTool } = vi.hoisted(() => ({ mockStream: vi.fn(), mockRunTool: vi.fn() }));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, streamChat: mockStream, runTool: mockRunTool };
});

import { runTurn, PLAN_INSTEAD_RESULT, PLAN_INSTEAD_CHANGE_RESULT, PLAN_INSTEAD_WORKTREE_RESULT, PLAN_INSTEAD_PAGE_RESULT, PLAN_INSTEAD_ACCESS_RESULT, PLAN_INSTEAD_LOCATION_RESULT } from "../agent";

// The model calls a tool that needs the user's answer; "plan" is the third
// answer to a command's approval. The model and the tool server are mocks.

const call = (name: string) => ({ id: "c1", name, arguments: JSON.stringify({ command: "npm install" }) });

function setup(needs: unknown, answer: unknown, name = "run_command") {
  mockStream
    .mockResolvedValueOnce({ toolCalls: [call(name)], usage: undefined })
    .mockResolvedValue({ toolCalls: [], usage: undefined });
  const ran: unknown[] = [];
  mockRunTool.mockImplementation(async (_call: any, ctx: any) => {
    if (ctx.approved || ctx.attachments?.includes("/x")) {
      ran.push(ctx);
      return { result: "ran" };
    }
    return needs;
  });
  const cb: Partial<RunTurnCallbacks> = {
    setMessages: () => {},
    setError: () => {},
    setFailed: () => {},
    setUsage: () => {},
    setAbort: () => {},
    refreshModels: () => {},
    askUser: async () => answer as any,
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
  return { config, cb: cb as RunTurnCallbacks, ran };
}

const toolText = (messages: any[]) => messages.filter((m) => m.role === "tool").map((m) => m.content);
const COMMAND = { needsApproval: { type: "command", command: "npm install", cwd: "/w" } };

beforeEach(() => {
  mockStream.mockReset();
  mockRunTool.mockReset();
});

describe("Make plan on a command approval", () => {
  it("runs nothing and tells the model to call update_plan", async () => {
    const t = setup(COMMAND, "plan");
    const r = await runTurn(t.config, t.cb);
    expect(t.ran).toEqual([]);
    expect(toolText(r.messages)).toEqual([PLAN_INSTEAD_RESULT]);
    expect(PLAN_INSTEAD_RESULT).toMatch(/update_plan/);
  });

  it("is not read as a yes: a no still gives the refusal, a yes still runs it", async () => {
    const no = setup(COMMAND, false);
    expect(toolText((await runTurn(no.config, no.cb)).messages)).toEqual(["Error: the user didn't approve running this command; it didn't run"]);
    mockStream.mockReset();
    mockRunTool.mockReset();
    const yes = setup(COMMAND, true);
    expect(toolText((await runTurn(yes.config, yes.cb)).messages)).toEqual(["ran"]);
  });

  it("on a file change writes nothing and tells the model to call update_plan", async () => {
    const t = setup({ needsApproval: { type: "change", path: "/w/a.txt", diff: "" } }, "plan", "write_file");
    const r = await runTurn(t.config, t.cb);
    expect(t.ran).toEqual([]);
    expect(toolText(r.messages)).toEqual([PLAN_INSTEAD_CHANGE_RESULT]);
    expect(PLAN_INSTEAD_CHANGE_RESULT).toBe(
      "The user doesn't want this done now; they want it as a plan. Call update_plan with the steps, this change included, then stop.",
    );
  });

  it("a no on a file change is still a refusal", async () => {
    const t = setup({ needsApproval: { type: "change", path: "/w/a.txt", diff: "" } }, false, "write_file");
    const r = await runTurn(t.config, t.cb);
    expect(t.ran).toEqual([]);
    expect(toolText(r.messages)[0]).toMatch(/^Error: the user didn't approve this change/);
  });

  it("on a worktree removal changes nothing and tells the model to call update_plan", async () => {
    const t = setup({ needsApproval: { type: "worktree", path: "/w/x" } }, "plan", "remove_worktree");
    const r = await runTurn(t.config, t.cb);
    expect(t.ran).toEqual([]);
    expect(toolText(r.messages)).toEqual([PLAN_INSTEAD_WORKTREE_RESULT]);
    expect(PLAN_INSTEAD_WORKTREE_RESULT).toMatch(/update_plan/);
  });

  it("on a page opening opens nothing and tells the model to call update_plan", async () => {
    const t = setup({ needsApproval: { type: "page", url: "https://example.com", host: "example.com" } }, "plan", "inspect_page");
    const r = await runTurn(t.config, t.cb);
    expect(t.ran).toEqual([]);
    expect(toolText(r.messages)).toEqual([PLAN_INSTEAD_PAGE_RESULT]);
    expect(PLAN_INSTEAD_PAGE_RESULT).toMatch(/update_plan/);
  });

  it("a no on a worktree removal or a page is still a refusal", async () => {
    const wt = setup({ needsApproval: { type: "worktree", path: "/w/x" } }, false, "remove_worktree");
    expect(toolText((await runTurn(wt.config, wt.cb)).messages)[0]).toMatch(/^Error: the user didn't approve removing the worktree/);
    mockStream.mockReset();
    mockRunTool.mockReset();
    const page = setup({ needsApproval: { type: "page", url: "https://example.com", host: "example.com" } }, false, "inspect_page");
    expect(toolText((await runTurn(page.config, page.cb)).messages)[0]).toMatch(/^Error: the user didn't allow opening https:\/\/example.com/);
  });

  it("on an access question reads nothing and tells the model to call update_plan", async () => {
    const t = setup({ needsAccess: { path: "/x", kind: "folder" } }, "plan", "read_file");
    const r = await runTurn(t.config, t.cb);
    expect(t.ran).toEqual([]);
    expect(toolText(r.messages)).toEqual([PLAN_INSTEAD_ACCESS_RESULT]);
    expect(PLAN_INSTEAD_ACCESS_RESULT).toMatch(/update_plan/);
  });

  it("on a path that doesn't exist (the model guessed) tells the model to plan too", async () => {
    const t = setup({ needsAccess: { path: "/nope", kind: null } }, "plan", "read_file");
    const r = await runTurn(t.config, t.cb);
    expect(toolText(r.messages)).toEqual([PLAN_INSTEAD_ACCESS_RESULT]);
  });

  it("on a thing to find (locate_path) tells the model to call update_plan", async () => {
    const t = setup({ needsLocation: { description: "the notes", kind: "folder" } }, "plan", "locate_path");
    const r = await runTurn(t.config, t.cb);
    expect(t.ran).toEqual([]);
    expect(toolText(r.messages)).toEqual([PLAN_INSTEAD_LOCATION_RESULT]);
    expect(PLAN_INSTEAD_LOCATION_RESULT).toMatch(/update_plan/);
  });

  it("a no on an access question is still a refusal", async () => {
    const t = setup({ needsAccess: { path: "/x", kind: "folder" } }, false, "read_file");
    const r = await runTurn(t.config, t.cb);
    expect(t.ran).toEqual([]);
    expect(toolText(r.messages)[0]).toMatch(/^Error: the user didn't allow access to \/x/);
  });
});
