import { describe, it, expect, vi } from "vitest";
import { type ToolCall, type ChatMessage, type PlanStep } from "../../api";
import {
  MAX_REPEATS,
  shouldBlockRepeat,
  recordCall,
  resetOnDiskChange,
  runPlan,
  checkStep,
  type RunPlanCallbacks,
} from "../agent";
import { filesChanged, ASIDE_TOOLS } from "../plan";

// ── shouldBlockRepeat (repeat guard) ────────────────────────────────────────

describe("shouldBlockRepeat", () => {
  function toolCall(name: string, args: object): ToolCall {
    return { name, arguments: JSON.stringify(args), id: "x" };
  }

  it("allows the first call (times = 0)", () => {
    const ran = new Map<string, number>();
    const call = toolCall("read_file", { path: "a.txt" });
    const result = shouldBlockRepeat(ran, call);
    expect(result.blocked).toBe(false);
    expect(result.times).toBe(0);
  });

  it("allows the second call (times = 1)", () => {
    const ran = new Map<string, number>();
    const call = toolCall("read_file", { path: "a.txt" });
    recordCall(ran, call);
    const result = shouldBlockRepeat(ran, call);
    expect(result.blocked).toBe(false);
    expect(result.times).toBe(1);
  });

  it("blocks the third call (times = 2 = MAX_REPEATS)", () => {
    const ran = new Map<string, number>();
    const call = toolCall("read_file", { path: "a.txt" });
    recordCall(ran, call);
    recordCall(ran, call);
    const result = shouldBlockRepeat(ran, call);
    expect(result.blocked).toBe(true);
    expect(result.times).toBe(2);
  });

  it("treats different tool names independently", () => {
    const ran = new Map<string, number>();
    const a = toolCall("read_file", { path: "a.txt" });
    const b = toolCall("write_file", { path: "b.txt" });
    recordCall(ran, a);
    recordCall(ran, a);
    expect(shouldBlockRepeat(ran, a).blocked).toBe(true);
    expect(shouldBlockRepeat(ran, b).blocked).toBe(false);
  });

  it("treats different arguments independently", () => {
    const ran = new Map<string, number>();
    const a = toolCall("read_file", { path: "a.txt" });
    const b = toolCall("read_file", { path: "b.txt" });
    recordCall(ran, a);
    recordCall(ran, a);
    expect(shouldBlockRepeat(ran, a).blocked).toBe(true);
    expect(shouldBlockRepeat(ran, b).blocked).toBe(false);
  });

  it("returns the correct key", () => {
    const ran = new Map<string, number>();
    const call = toolCall("read_file", { path: "src/foo.ts" });
    const result = shouldBlockRepeat(ran, call);
    expect(result.key).toBe("read_file {\"path\":\"src/foo.ts\"}");
  });
});

// ── recordCall ──────────────────────────────────────────────────────────────

describe("recordCall", () => {
  function toolCall(name: string, args: object): ToolCall {
    return { name, arguments: JSON.stringify(args), id: "x" };
  }

  it("increments the counter for the same call", () => {
    const ran = new Map<string, number>();
    const call = toolCall("read_file", { path: "a.txt" });
    recordCall(ran, call);
    recordCall(ran, call);
    recordCall(ran, call);
    expect(ran.get("read_file {\"path\":\"a.txt\"}")).toBe(3);
  });

  it("starts at 1 for a new call", () => {
    const ran = new Map<string, number>();
    const call = toolCall("write_file", { path: "b.txt" });
    recordCall(ran, call);
    expect(ran.get("write_file {\"path\":\"b.txt\"}")).toBe(1);
  });
});

// ── resetOnDiskChange ───────────────────────────────────────────────────────

describe("resetOnDiskChange", () => {
  function toolCall(name: string, args: object): ToolCall {
    return { name, arguments: JSON.stringify(args), id: "x" };
  }

  it("clears the counter on successful write_file", () => {
    const ran = new Map<string, number>();
    const call = toolCall("write_file", { path: "a.txt" });
    recordCall(ran, call);
    recordCall(ran, call);
    resetOnDiskChange(ran, call, "OK");
    expect(ran.size).toBe(0);
  });

  it("clears the counter on successful edit_file", () => {
    const ran = new Map<string, number>();
    const call = toolCall("edit_file", { path: "a.txt" });
    recordCall(ran, call);
    resetOnDiskChange(ran, call, "OK");
    expect(ran.size).toBe(0);
  });

  it("clears the counter on successful run_command", () => {
    const ran = new Map<string, number>();
    const call = toolCall("run_command", { command: "ls" });
    recordCall(ran, call);
    resetOnDiskChange(ran, call, "output");
    expect(ran.size).toBe(0);
  });

  it("does not clear on error results", () => {
    const ran = new Map<string, number>();
    const call = toolCall("write_file", { path: "a.txt" });
    recordCall(ran, call);
    recordCall(ran, call);
    resetOnDiskChange(ran, call, "Error: permission denied");
    expect(ran.get("write_file {\"path\":\"a.txt\"}")).toBe(2);
  });

  it("does not clear for read_file (not a disk changer)", () => {
    const ran = new Map<string, number>();
    const call = toolCall("read_file", { path: "a.txt" });
    recordCall(ran, call);
    recordCall(ran, call);
    resetOnDiskChange(ran, call, "file contents");
    expect(ran.get("read_file {\"path\":\"a.txt\"}")).toBe(2);
  });
});

// ── ASIDE_TOOLS (side questions) ────────────────────────────────────────────

describe("ASIDE_TOOLS", () => {
  it("is the explicit read-only list", () => {
    expect([...ASIDE_TOOLS].sort()).toEqual(
      [
        "fetch_url", "find_files", "grep", "list_directory", "locate_path",
        "read_file", "read_thread", "summarize_thread", "web_search",
      ].sort(),
    );
  });

  it("has no run_command and no write tools", () => {
    for (const n of ["run_command", "write_file", "edit_file", "create_worktree", "remove_worktree"]) {
      expect(ASIDE_TOOLS.has(n)).toBe(false);
    }
  });

  it("has nothing that changes the plan or the todo list", () => {
    for (const n of ["update_plan", "add_todo", "list_todos", "complete_todo"]) {
      expect(ASIDE_TOOLS.has(n)).toBe(false);
    }
  });
});

// ── MAX_REPEATS constant ────────────────────────────────────────────────────

describe("MAX_REPEATS", () => {
  it("equals 2", () => {
    expect(MAX_REPEATS).toBe(2);
  });
});

// ── runPlan early-return guard ──────────────────────────────────────────────

function mockCallbacks(overrides?: Partial<RunPlanCallbacks>): RunPlanCallbacks {
  return {
    connector: { id: "test-connector" } as any,
    model: "test-model",
    abort: null,
    planRunningRef: { current: false },
    setPlanRunning: vi.fn(),
    messages: [],
    planRef: { current: null },
    setStep: vi.fn(),
    reply: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
    setError: vi.fn(),
    setAbort: vi.fn(),
    modelLoaded: vi.fn().mockResolvedValue(true),
    models: [{ id: "test-model" }] as any[],
    workingDir: null,
    attachments: [],
    checkCommands: {},
    attachedPaths: () => [],
    sessionId: "test-session",
    modelOptions: {},
    toolDefinitions: [],
    ...overrides,
  };
}

describe("runPlan", () => {
  it("returns immediately when planRunningRef is true", async () => {
    const ref = { current: true };
    const cb = mockCallbacks({ planRunningRef: ref });
    await runPlan(cb);
    expect(cb.setPlanRunning).not.toHaveBeenCalled();
    expect(cb.reply).not.toHaveBeenCalled();
  });

  it("returns immediately when connector is null", async () => {
    const cb = mockCallbacks({ connector: null });
    await runPlan(cb);
    expect(cb.setPlanRunning).not.toHaveBeenCalled();
  });

  it("returns immediately when model is empty", async () => {
    const cb = mockCallbacks({ model: "" });
    await runPlan(cb);
    expect(cb.setPlanRunning).not.toHaveBeenCalled();
  });

  it("returns immediately when abort is set", async () => {
    const cb = mockCallbacks({ abort: new AbortController() });
    await runPlan(cb);
    expect(cb.setPlanRunning).not.toHaveBeenCalled();
  });

  it("sets planRunningRef and setPlanRunning while running", async () => {
    const ref = { current: false };
    const setPlanRunning = vi.fn();
    const steps: PlanStep[] = [{ id: "s1", text: "Step 1", status: "pending" }];
    const cb = mockCallbacks({ planRunningRef: ref, setPlanRunning, planRef: { current: steps } });
    vi.spyOn(cb, "reply").mockResolvedValueOnce({ ok: true, messages: [] });
    await runPlan(cb);
    expect(setPlanRunning).toHaveBeenCalledWith(true);
  });

  it("gives no step a side question: not in the history it is sent, nor in what it returns", async () => {
    const steps: PlanStep[] = [{ id: "s1", text: "Step 1", status: "pending" }];
    const side: ChatMessage = { role: "user", content: "side?", aside: true };
    const sideAnswer: ChatMessage = { role: "assistant", content: "side!", aside: true };
    const seen: ChatMessage[][] = [];
    const cb = mockCallbacks({
      planRef: { current: steps },
      messages: [{ role: "user", content: "request" }, side, sideAnswer],
      reply: vi.fn(async (_text: string, before: ChatMessage[]) => {
        seen.push(before);
        return { ok: false, messages: before };
      }),
    });
    await runPlan(cb);
    expect(seen).toHaveLength(1);
    expect(seen[0].map((m) => m.content)).toEqual(["request"]);
  });

  it("resets planRunningRef after completion", async () => {
    const ref = { current: false };
    const setPlanRunning = vi.fn();
    const cb = mockCallbacks({ planRunningRef: ref, setPlanRunning });
    // no plan steps → loop exits immediately
    await runPlan(cb);
    expect(ref.current).toBe(false);
    expect(setPlanRunning).toHaveBeenCalledWith(false);
  });

  it("exits when no plan steps exist", async () => {
    const cb = mockCallbacks({ planRef: { current: [] } });
    await runPlan(cb);
    expect(cb.setStep).not.toHaveBeenCalled();
  });

  it("exits when all steps are done", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Step 1", status: "done" },
      { id: "s2", text: "Step 2", status: "done" },
    ];
    const cb = mockCallbacks({ planRef: { current: steps } });
    await runPlan(cb);
    expect(cb.setStep).not.toHaveBeenCalled();
  });
});

describe("runPlan context", () => {
  it("starts each step's history at the step, with the plan's request", async () => {
    const steps: PlanStep[] = [{ id: "s1", text: "Step 1", status: "pending" }];
    const earlier: ChatMessage[] = [
      { role: "user", content: "the request" },
      { role: "assistant", content: "planning chatter" },
    ];
    const reply = vi.fn().mockResolvedValue({ ok: false, messages: earlier });
    await runPlan(mockCallbacks({ planRef: { current: steps }, messages: earlier, reply, request: "the request" }));
    const [text, before, opts] = reply.mock.calls[0];
    expect(before).toBe(earlier);
    expect(opts).toMatchObject({ planStep: "s1", from: earlier.length });
    expect(text).toContain("The task the plan is for:\nthe request");
  });
});

// ── checkStep early-return guard ────────────────────────────────────────────

describe("checkStep", () => {
  function mockDeps(overrides?: Partial<any>): any {
    return {
      connector: { id: "test-connector" },
      model: "test-model",
      setAbort: vi.fn(),
      setError: vi.fn(),
      modelLoaded: vi.fn().mockResolvedValue(true),
      models: [{ id: "test-model", contextSize: 4096 }],
      workingDir: null,
      attachments: [],
      attachedPaths: () => [],
      sessionId: "test-session",
      ...overrides,
    };
  }

  it("returns null when connector is null", async () => {
    const deps = mockDeps({ connector: null });
    const result = await checkStep("do something", [], [], deps);
    expect(result).toBeNull();
  });

  it("returns null when model is not loaded", async () => {
    const deps = mockDeps({ modelLoaded: vi.fn().mockResolvedValue(false) });
    const result = await checkStep("do something", [], [], deps);
    expect(result).toBeNull();
  });
});
