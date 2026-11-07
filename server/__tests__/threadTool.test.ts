import { describe, expect, it, vi } from "vitest";

// sessionFile.ts reads the home folder when it loads; point it at a temp one.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const mockStream = vi.hoisted(() => vi.fn());
vi.mock("../../src/api.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/api.ts")>()), streamChat: mockStream }));

const mockWorktrees = vi.hoisted(() => vi.fn());
vi.mock("../worktreeStatus.ts", () => ({ worktreeStatuses: mockWorktrees }));
mockWorktrees.mockResolvedValue([]);

const { THREAD_TOOLS, summaryPrompt, transcript } = await import("../threads.ts");
const { writeSession } = await import("../sessionFile.ts");
import type { ToolContext } from "../toolkit.ts";

const store = { connectors: [{ id: "k", kind: "anthropic", api: "anthropic" }] };
const tool = (name: string) => THREAD_TOOLS.find((t) => t.name === name)!;
const call = (name: string) => (chatId: string, args: unknown = {}, ctx: Partial<ToolContext> = { connectorId: "k", model: "parent-model" }) =>
  tool(name).run({ store, chatId, attachments: [], approved: null, todos: [], ...ctx } as unknown as ToolContext, args);
const run = call("summarize_thread");
const read = call("read_thread");

// The model answers with `text`, in pieces.
const answers = (text: string) =>
  mockStream.mockImplementation(async (_req: any, onDelta: (d: any) => void) => {
    for (const piece of text.match(/.{1,7}/gs) ?? []) onDelta({ content: piece });
    return {};
  });

const note = (sessionId: string, summary: string, extra = {}) => ({ sessionId, summary, anchor: null, ...extra });

const child = (extra = {}) => ({
  messages: [
    { role: "user", content: "Do the thing" },
    { role: "assistant", content: "Working on it." },
    { role: "assistant", content: "All done: the worktree is at /w and the server answers 200." },
  ],
  plan: [
    { id: "1", text: "Make a worktree", summary: "Worktree", status: "done" },
    { id: "2", text: "Start the server", status: "failed", note: "port was busy" },
  ],
  ...extra,
});

const done = (extra = {}) =>
  child({
    plan: [
      { id: "1", text: "Make a worktree", status: "done", ms: 12_000 },
      { id: "2", text: "Start the server", status: "done", note: "checked" },
    ],
    messages: [
      { role: "user", content: "Do the thing" },
      { role: "assistant", content: "Made it.", planStep: "1" },
      { role: "assistant", content: "", planStep: "2", toolCalls: [{ id: "w1", name: "write_file", arguments: '{"path":"src/a.ts","content":"x"}' }] },
      { role: "tool", content: "Wrote src/a.ts", toolCallId: "w1", planStep: "2" },
      { role: "assistant", content: "The server answers 200 on 5174.\nSTEP DONE", planStep: "2" },
      { role: "assistant", content: "STEP DONE", planStep: "2" },
      { role: "user", content: "thanks, what is a worktree?" },
      { role: "assistant", content: "A worktree is a second checkout." },
    ],
    ...extra,
  });

describe("read_thread", () => {
  it("gives the outcome, steps, the plan's result and the files, without asking a model", async () => {
    mockStream.mockClear();
    await writeSession("r1", done());
    await writeSession("rp1", { threads: [note("r1", "Set up the server", { status: "done" })] });
    const text = await read("rp1");
    expect(text).toMatch(/^Thread: Set up the server\n\nOutcome: SUCCESS/);
    expect(text).toContain("1. [done, 12s] Make a worktree");
    expect(text).toContain("Result: The server answers 200 on 5174.");
    expect(text).toContain("Files changed:\n- src/a.ts");
    expect(text).not.toContain("STEP DONE");
    expect(text).not.toContain("second checkout");
    expect(text).not.toContain("Next:");
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("is not changed by a later chat reply or a verdict line", async () => {
    await writeSession("r3", done());
    await writeSession("r4", done({ messages: done().messages.slice(0, 5) }));
    await writeSession("rp3", { threads: [note("r3", "With chat"), note("r4", "Without chat")] });
    const result = (t: string) => t.slice(t.indexOf("Outcome:"));
    expect(result(await read("rp3", { thread: "r3" }))).toBe(result(await read("rp3", { thread: "r4" })));
  });

  it("shows FAILED with the step's note and a Next line", async () => {
    await writeSession("r1f", child());
    await writeSession("rp1f", { threads: [note("r1f", "Set up the server", { status: "failed" })] });
    const text = await read("rp1f");
    expect(text).toContain("Outcome: FAILED");
    expect(text).toContain("2. [failed] Start the server - port was busy");
    expect(text).toContain("Result: none yet.");
    expect(text).toMatch(/Next: step 2 failed/);
    expect(text).toContain("Files changed: none");
  });

  it("adds the worktree lines, and leaves them out when git can't be read", async () => {
    await writeSession("r5", done());
    await writeSession("rp5", { threads: [note("r5", "Worktree")] });
    mockWorktrees.mockResolvedValueOnce([{ name: "ui", branch: "llama/ui", uncommitted: 2, unmerged: 1, base: "main" }]);
    expect(await read("rp5")).toContain("In worktree ui (llama/ui): 2 files uncommitted, 1 commit not on main");
    mockWorktrees.mockRejectedValueOnce(new Error("git is gone"));
    const text = await read("rp5");
    expect(text).toContain("Outcome: SUCCESS");
    expect(text).not.toContain("In worktree");
  });

  it("caps the overview, keeps the result and the failing note first, and says how to get more", async () => {
    const { OVERVIEW_MAX, RESULT_MAX } = await import("../threads.ts");
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const plan = ids.map((id, i) => ({
      id,
      text: `Step text ${i + 1}`,
      status: i === 8 ? "failed" : i < 8 ? "done" : "pending",
      note: i === 8 ? `FAIL-START ${"f".repeat(5000)}` : `note ${i + 1} ${"n".repeat(3000)}`,
    }));
    const writes = Array.from({ length: 80 }, (_, i) => [
      { role: "assistant", content: "", planStep: "1", toolCalls: [{ id: `w${i}`, name: "write_file", arguments: JSON.stringify({ path: `src/some/long/path/file${i}.ts`, content: "x" }) }] },
      { role: "tool", content: "Wrote", toolCallId: `w${i}`, planStep: "1" },
    ]).flat();
    await writeSession("c9", {
      plan,
      messages: [
        ...writes,
        { role: "assistant", content: `SAID-START ${"s".repeat(20_000)} SAID-END`, planStep: "9" },
      ],
    });
    await writeSession("cp9", { threads: [note("c9", "Long thread")] });
    mockWorktrees.mockResolvedValueOnce([{ name: "ui", branch: "llama/ui", uncommitted: 2, unmerged: 1, base: "main" }]);
    const text = await read("cp9");
    expect(text.length).toBeLessThanOrEqual(OVERVIEW_MAX);
    expect(text).toContain("Outcome: FAILED");
    expect(text).toContain("FAIL-START");
    expect(text).toMatch(/Next: step 9 failed/);
    expect(text).toContain("SAID-END");
    expect(text).not.toContain("SAID-START");
    expect(text.match(/s+/g)!.sort((a, b) => b.length - a.length)[0].length).toBeLessThanOrEqual(RESULT_MAX);
    expect(text).toContain("9. [failed] Step text 9 - FAIL-START");
    expect(text).toContain("7. [done] Step text 7");
    expect(text).not.toContain("note 7");
    expect(text).toContain("- …and ");
    expect(text.trimEnd().split("\n").pop()).toMatch(/^More: read_thread with `step` \(1 to 10\).*summarize_thread with a `focus`/);

    // A short thread is the same answer plus the pointer line, nothing cut.
    await writeSession("c10", done());
    await writeSession("cp10", { threads: [note("c10", "Short")] });
    const short = await read("cp10");
    expect(short).toContain("1. [done, 12s] Make a worktree");
    expect(short).toContain("Files changed:\n- src/a.ts");
    expect(short.trimEnd().split("\n").pop()).toMatch(/^More: read_thread with `step` \(1 to 2\)/);
  });

  it("with `step` gives that step's detail instead of the overview", async () => {
    mockStream.mockClear();
    await writeSession("s1", done({ messages: [
      { role: "user", content: "Do step 2", planStep: "2" },
      { role: "assistant", content: "Made it.", planStep: "1" },
      { role: "assistant", content: "Starting.", planStep: "2", toolCalls: [{ id: "c1", name: "run_command", arguments: '{"command":"npm start"}' }] },
      { role: "tool", content: "EADDRINUSE 5174", toolCallId: "c1", planStep: "2" },
      { role: "assistant", content: "The port is busy.", planStep: "2" },
      { role: "assistant", content: "A later chat reply." },
    ] }));
    await writeSession("sp1", { threads: [note("s1", "Set up the server")] });
    for (const step of [2, "2"]) {
      const text = await read("sp1", { step });
      expect(text).toMatch(/^Thread: Set up the server\n\nStep 2: Start the server\nState: done\nNote: checked/);
      expect(text).toContain("The port is busy.");
      expect(text).toContain("$ run_command npm start\nEADDRINUSE 5174");
      expect(text).not.toContain("Made it.");
      expect(text).not.toContain("later chat reply");
      expect(text).not.toContain("Outcome:");
    }
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("keeps the end of a long step and says it was cut", async () => {
    const { STEP_DETAIL_MAX } = await import("../threads.ts");
    await writeSession("s2", done({ messages: [
      { role: "assistant", content: "", planStep: "2", toolCalls: [{ id: "c1", name: "run_command", arguments: '{"command":"build"}' }] },
      { role: "tool", content: `START-MARK ${"x".repeat(20_000)} END-MARK`, toolCallId: "c1", planStep: "2" },
    ] }));
    await writeSession("sp2", { threads: [note("s2", "Long")] });
    const text = await read("sp2", { step: 2 });
    const body = text.slice("Thread: Long\n\n".length);
    expect(body.length).toBeLessThanOrEqual(STEP_DETAIL_MAX);
    expect(text).toContain("the start was cut");
    expect(text).toContain("END-MARK");
    expect(text).not.toContain("START-MARK");
    expect(text).toContain("Step 2: Start the server");
  });

  it("says plainly which steps exist when the step isn't one", async () => {
    await writeSession("s3", done());
    await writeSession("s4", child({ plan: [] }));
    await writeSession("sp3", { threads: [note("s3", "Two steps"), note("s4", "No steps")] });
    for (const step of [0, 3, -1, 1.5, "abc"]) {
      await expect(read("sp3", { thread: "s3", step })).rejects.toThrow(/no step .*numbered 1 to 2/);
    }
    await expect(read("sp3", { thread: "s4", step: 1 })).rejects.toThrow(/has no steps to read/);
  });

  it("says when there is nothing to read, or the thread is gone", async () => {
    await writeSession("r2", child({ messages: [] }));
    await writeSession("rp2", { threads: [note("r2", "Quiet"), note("gone", "Lost")] });
    expect(await read("rp2", { thread: "quiet" })).toContain("Result: none yet. Step 2 last said: (nothing)");
    expect(await read("rp2", { thread: "lost" })).toMatch(/was deleted, so there is nothing to read/);
    await expect(read("rp2")).rejects.toThrow(/2 threads/);
    await expect(read("none")).rejects.toThrow(/nothing to read/);
  });
});

describe("summarize_thread", () => {
  it("says there is nothing to summarize when the chat started no threads", async () => {
    await writeSession("p0", { messages: [] });
    await expect(run("p0")).rejects.toThrow(/hasn't started any threads/);
    await expect(run("never-saved")).rejects.toThrow(/hasn't started any threads/);
  });

  it("asks the thread's model, with the whole record and the focus, and returns its summary", async () => {
    await writeSession("c1", child({ model: "child-model", messages: [
      { role: "user", content: "Do the thing" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "run_command", arguments: '{"command":"ls"}' }] },
      { role: "tool", content: "x".repeat(20_000), toolCallId: "t1" },
      { role: "assistant", content: "All done." },
    ] }));
    await writeSession("p1", { threads: [note("c1", "Set up the server", { status: "failed", report: { text: "Step 2 failed.", at: 1 } })] });
    answers("The server is up on 5174; step 2 hit a busy port.");
    const text = await run("p1", { focus: "what failed" });
    expect(text).toContain("Thread: Set up the server");
    expect(text).toContain("Outcome: failed");
    expect(text).toContain("2. Start the server: failed (port was busy)");
    expect(text).toContain("Summary from the thread's model:\nThe server is up on 5174; step 2 hit a busy port.");
    const req = mockStream.mock.calls.at(-1)![0];
    expect(req.connectorId).toBe("k");
    expect(req.model).toBe("child-model");
    expect(req.tools).toEqual([]);
    const prompt = req.messages[0].content as string;
    expect(prompt).toContain("What the chat most needs from it: what failed");
    expect(prompt).toContain('Assistant called run_command({"command":"ls"})');
    expect(prompt).toContain("x".repeat(20_000));
  });

  it("uses the chat's model when the thread has none saved", async () => {
    await writeSession("c6", child({ model: "" }));
    await writeSession("p6", { threads: [note("c6", "No model")] });
    answers("ok");
    await run("p6");
    expect(mockStream.mock.calls.at(-1)![0].model).toBe("parent-model");
  });

  it("gives the steps and the short report when the model can't be asked", async () => {
    await writeSession("c7", child());
    await writeSession("p7", { threads: [note("c7", "Broken", { status: "failed", report: { text: "Step 2 failed.", at: 1 } })] });
    mockStream.mockRejectedValue(new Error("model isn't loaded"));
    const text = await run("p7");
    expect(text).toContain("2. Start the server: failed");
    expect(text).toContain("Short report written when it ended: Step 2 failed.");
    expect(text).toContain("A summary couldn't be written (model isn't loaded)");
    answers("");
    expect(await run("p7")).toContain("the model answered with nothing");
    expect(await run("p7", {}, {})).toContain("the chat's model server isn't known");
  });

  it("asks which thread when there are several, and takes an id or a piece of the summary", async () => {
    await writeSession("c2", child());
    await writeSession("c3", child());
    await writeSession("p2", { threads: [note("c2", "Set up the server"), note("c3", "Rename the tool")] });
    answers("fine");
    await expect(run("p2")).rejects.toThrow(/2 threads.*c2: Set up the server.*c3: Rename the tool/s);
    expect(await run("p2", { thread: "c3" })).toContain("Thread: Rename the tool");
    expect(await run("p2", { thread: "set up" })).toContain("Thread: Set up the server");
    await expect(run("p2", { thread: "nothing like it" })).rejects.toThrow(/no thread matches/);
  });

  it("only reads this chat's own threads", async () => {
    await writeSession("c4", child());
    await writeSession("p3", { threads: [note("c4", "Mine")] });
    await writeSession("other", { threads: [] });
    await expect(run("other", { thread: "c4" })).rejects.toThrow(/hasn't started any threads/);
  });

  it("says so when the thread was deleted", async () => {
    await writeSession("p4", { threads: [note("gone", "Lost")] });
    expect(await run("p4")).toMatch(/was deleted/);
  });
});

describe("the record sent to the thread's model", () => {
  it("has every message whole, with tool calls and results", () => {
    const text = transcript([
      { role: "user", content: "Go" },
      { role: "assistant", content: "Looking.", toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a"}' }] },
      { role: "tool", content: "contents of a", toolCallId: "1" },
    ] as any);
    expect(text).toBe('User: Go\n\nAssistant: Looking.\n\nAssistant called read_file({"path":"a"})\n\nTool result:\ncontents of a');
    expect(summaryPrompt([{ role: "user", content: "Go" }] as any, "")).not.toContain("most needs");
  });

  it("asks for the follow-up steps, or an explicit none", () => {
    const prompt = summaryPrompt([{ role: "user", content: "Go" }] as any, "");
    expect(prompt).toContain('"Follow-up:"');
    expect(prompt).toContain("restart or refresh the server");
    expect(prompt).toContain('"Follow-up: none"');
  });
});
