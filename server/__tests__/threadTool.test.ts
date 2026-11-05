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

describe("read_thread", () => {
  it("gives the steps and the thread's final message whole, without asking a model", async () => {
    mockStream.mockClear();
    const long = "word ".repeat(5000).trim();
    await writeSession("r1", child({ messages: [{ role: "assistant", content: "early" }, { role: "assistant", content: long }, { role: "assistant", content: "  " }] }));
    await writeSession("rp1", { threads: [note("r1", "Set up the server", { status: "failed" })] });
    const text = await read("rp1");
    expect(text).toContain("Outcome: failed");
    expect(text).toContain("2. Start the server: failed (port was busy)");
    expect(text).toContain(`The thread's final message:\n${long}`);
    expect(text).not.toContain("early");
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("says when there is nothing to read, or the thread is gone", async () => {
    await writeSession("r2", child({ messages: [] }));
    await writeSession("rp2", { threads: [note("r2", "Quiet"), note("gone", "Lost")] });
    expect(await read("rp2", { thread: "quiet" })).toContain("The thread has no final message.");
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
