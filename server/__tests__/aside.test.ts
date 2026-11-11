import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../../src/agent/agent.ts";
import { ASIDE_TOOLS } from "../../src/agent/plan.ts";
import type { ChatMessage } from "../../src/api.ts";
import type { RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";
import { fakeRun, finish, handles, makeSession, resetFakes } from "./fakeRun.ts";
import { fileOf, files, putFile } from "./memorySessions.ts";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui. The session
// files themselves are held in memory (see memorySessions.ts).
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});
vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original<object>()));

const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");
const { startAside, stopAside } = await import("../aside.ts");

// A side question while a plan runs: answered beside the plan, written into
// the session through the run, never seen by the plan's steps. The plan is the
// fake run of fakeRun.ts, and the reply a fake turn, so no model is needed.

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true, kind: "llama", api: "openai" } as any,
  model: "m",
  models: [],
  toolContext: {
    definitions: ["read_file", "write_file", "update_plan", "run_command", "grep"].map((name) => ({ function: { name } })),
    systemPrompt: "tools",
    update: "",
    checkCommands: {},
  } as any,
  toolsOn: true,
  modelOptions: {},
} as RunnerEnv;

const earlier: ChatMessage[] = [
  { role: "user", content: "Make the thing" },
  { role: "assistant", content: "Planned." },
];

let configs: RunTurnConfig[] = [];
// Lets the fake reply finish; until then it is streaming.
let finishReply: () => void = () => {};

// What runTurn does for the parts these tests look at: it writes the history,
// the question and its answer through setMessages, then waits for the test.
async function fakeTurn(config: RunTurnConfig, cb: RunTurnCallbacks) {
  configs.push(config);
  const question: ChatMessage = { role: "user", content: config.text, note: config.note, aside: true };
  cb.setMessages([...config.history, question, { role: "assistant", content: "Working on it", aside: true }]);
  await new Promise<void>((resolve) => {
    finishReply = resolve;
    config.controller.signal.addEventListener("abort", () => resolve());
  });
  if (config.controller.signal.aborted) return { ok: false, messages: [], attached: [] };
  cb.setMessages([...config.history, question, { role: "assistant", content: "It is on step 1.", aside: true }]);
  return { ok: true, messages: [], attached: [] };
}

// The plan's replies are not used (fakeRun walks the steps itself); the reply
// factory only hands the test the run's handle, which is what a reply writes with.
const planReply = (h: RunnerHandle) => {
  handles.set(h.sessionId, h);
  return async (_text: string, before: ChatMessage[]) => ({ ok: true, messages: before });
};

async function runPlan(id = "a", extra: Partial<ReturnType<typeof makeSession>> = {}) {
  putFile(id, { ...makeSession(id, 2), messages: earlier, revision: 1, ...extra });
  return runners.startRunner(id, env, { run: (cb) => fakeRun(id, cb), reply: planReply, save: (s) => hub.save(s.id, s) });
}

// What a step's reply does to the session: it writes back the list it has.
const planWrites = (id: string, messages: ChatMessage[]) => handles.get(id)!.edit((s) => ({ ...s, messages }));

const reasonOf = async (p: Promise<unknown>) => p.then(() => null, (e) => ({ status: e.status, reason: e.extra?.reason }));

beforeEach(() => {
  resetFakes();
  configs = [];
  finishReply = () => {};
});

afterEach(async () => {
  await runners.resetRunners();
  files.clear();
});

describe("a side question during a plan", () => {
  it("is answered while the plan runs, and both go into the session marked as aside", async () => {
    const run = await runPlan();
    await vi.waitFor(() => expect(handles.has("a")).toBe(true));
    const { done } = await startAside("a", env, "  What is it doing?  ", { turn: fakeTurn });
    // The question is in the session as soon as startAside answers.
    const messages = () => handles.get("a")!.getSession().messages as ChatMessage[];
    expect(messages().map((m) => [m.role, m.aside ?? false])).toEqual([
      ["user", false],
      ["assistant", false],
      ["user", true],
      ["assistant", true],
    ]);
    expect(messages()[2].content).toBe("What is it doing?");
    // The plan keeps running meanwhile: still running, not waiting for it.
    expect(hub.liveRun("a")).toMatchObject({ status: "running" });
    finishReply();
    await done;
    expect(messages().at(-1)).toMatchObject({ content: "It is on step 1.", aside: true });
    finish("a", "s1");
    finish("a", "s2");
    await run.done;
    expect(fileOf("a").messages.filter((m: ChatMessage) => m.aside).map((m: ChatMessage) => m.content)).toEqual([
      "What is it doing?",
      "It is on step 1.",
    ]);
  });

  it("survives the plan writing back its own list of messages", async () => {
    const run = await runPlan();
    await vi.waitFor(() => expect(handles.has("a")).toBe(true));
    const { done } = await startAside("a", env, "Why?", { turn: fakeTurn });
    finishReply();
    await done;
    // A step's reply sets the messages to what it has: the earlier ones and its own.
    const step: ChatMessage[] = [...earlier, { role: "user", content: "Do step 1", planStep: "s1" }, { role: "assistant", content: "Done", planStep: "s1" }];
    planWrites("a", step);
    const now = handles.get("a")!.getSession().messages as ChatMessage[];
    expect(now.map((m) => m.content)).toEqual([
      "Make the thing",
      "Planned.",
      "Why?",
      "It is on step 1.",
      "Do step 1",
      "Done",
    ]);
    // And once more, longer, as the next reply would.
    planWrites("a", [...step, { role: "user", content: "Do step 2", planStep: "s2" }]);
    expect((handles.get("a")!.getSession().messages as ChatMessage[]).filter((m) => m.aside)).toHaveLength(2);
    finish("a", "s1");
    finish("a", "s2");
    await run.done;
    const saved = fileOf("a").messages as ChatMessage[];
    expect(saved.filter((m) => m.aside)).toHaveLength(2);
    expect(saved.at(-1)?.content).toBe("Do step 2");
    expect(fileOf("a").run).toBeUndefined();
  });

  it("asks the model with the read-only tools, a note about the plan, and the chat without the steps' messages", async () => {
    const stepMessages: ChatMessage[] = [
      { role: "user", content: "Do step 1", planStep: "s1" },
      { role: "assistant", content: "Reading the file now", planStep: "s1" },
    ];
    const run = await runPlan("a", { messages: [...earlier, ...stepMessages] });
    await vi.waitFor(() => expect(handles.has("a")).toBe(true));
    await vi.waitFor(() => expect(runners.isRunning("a")).toBe(true));
    // Step 1 is running once the fake run has started it.
    await vi.waitFor(() => expect(handles.get("a")!.getSession().plan?.[0].status).toBe("running"));
    const { done } = await startAside("a", env, "Status?", { turn: fakeTurn });
    const c = configs[0];
    expect(c.allowedTools).toBe(ASIDE_TOOLS);
    expect(c.aside).toBe(true);
    expect(c.planning).toBe(false);
    expect(c.history.map((m) => m.content)).toEqual(["Make the thing", "Planned."]);
    expect((c.toolDefinitions as any[]).map((d) => d.function.name)).toEqual(["read_file", "grep"]);
    expect(c.note).toContain("side question");
    expect(c.note).toContain("1. [running] Step 1");
    expect(c.note).toContain("2. [pending] Step 2");
    expect(c.note).toContain("Reading the file now");
    finishReply();
    await done;
    finish("a", "s1");
    finish("a", "s2");
    await run.done;
  });

  it("takes one at a time: a second is refused with a plain reason, until the first is over", async () => {
    const run = await runPlan();
    await vi.waitFor(() => expect(handles.has("a")).toBe(true));
    const first = await startAside("a", env, "One", { turn: fakeTurn });
    expect(await reasonOf(startAside("a", env, "Two", { turn: fakeTurn }))).toEqual({ status: 409, reason: "aside running" });
    await expect(startAside("a", env, "Two", { turn: fakeTurn })).rejects.toThrow(/still in the box/);
    expect(configs).toHaveLength(1);
    finishReply();
    await first.done;
    const second = await startAside("a", env, "Two", { turn: fakeTurn });
    expect(configs).toHaveLength(2);
    // The second question's history has the first exchange in it.
    expect(configs[1].history.map((m) => m.content)).toEqual(["Make the thing", "Planned.", "One", "It is on step 1."]);
    expect(configs[1].history.some((m) => m.aside)).toBe(false);
    finishReply();
    await second.done;
    finish("a", "s1");
    finish("a", "s2");
    await run.done;
    expect((fileOf("a").messages as ChatMessage[]).filter((m) => m.aside).map((m) => m.content)).toEqual([
      "One",
      "It is on step 1.",
      "Two",
      "It is on step 1.",
    ]);
  });

  it("is refused when no plan is running, and when only a reply is", async () => {
    putFile("a", { ...makeSession("a", 2), revision: 1 });
    expect(await reasonOf(startAside("a", env, "Hi", { turn: fakeTurn }))).toEqual({ status: 409, reason: "not running" });
    await runners.startTurn("a", env, { text: "chat", planning: false }, {
      reply: (() => () => new Promise(() => {})) as any,
      save: (s) => hub.save(s.id, s),
    });
    expect(await reasonOf(startAside("a", env, "Hi", { turn: fakeTurn }))).toEqual({ status: 409, reason: "not running" });
    expect(configs).toEqual([]);
    expect(await reasonOf(startAside("a", env, "  ", { turn: fakeTurn }))).toEqual({ status: 400, reason: undefined });
  });

  it("stops by itself, keeping what it wrote, and the plan goes on", async () => {
    const run = await runPlan();
    await vi.waitFor(() => expect(handles.has("a")).toBe(true));
    const { done } = await startAside("a", env, "Slow one", { turn: fakeTurn });
    expect(stopAside("a")).toBe(true);
    await done;
    expect(stopAside("a")).toBe(false);
    const messages = handles.get("a")!.getSession().messages as ChatMessage[];
    expect(messages.filter((m) => m.aside).map((m) => m.content)).toEqual(["Slow one", "Working on it"]);
    expect(runners.isRunning("a")).toBe(true);
    expect(hub.liveRun("a")).toMatchObject({ status: "running" });
    // A new one can start now.
    const next = await startAside("a", env, "Again", { turn: fakeTurn });
    finishReply();
    await next.done;
    finish("a", "s1");
    finish("a", "s2");
    await run.done;
  });

  it("is cut off, keeping what it wrote, when the plan ends first", async () => {
    const run = await runPlan();
    await vi.waitFor(() => expect(handles.has("a")).toBe(true));
    await startAside("a", env, "Still there?", { turn: fakeTurn });
    finish("a", "s1");
    finish("a", "s2");
    await run.done;
    expect(runners.isRunning("a")).toBe(false);
    const saved = fileOf("a");
    expect(saved.messages.filter((m: ChatMessage) => m.aside).map((m: ChatMessage) => m.content)).toEqual(["Still there?", "Working on it"]);
    expect(saved.run).toBeUndefined();
    // Nothing starts once the run is over.
    expect(await reasonOf(startAside("a", env, "Late", { turn: fakeTurn }))).toEqual({ status: 409, reason: "not running" });
  });

  it("says in the chat when the reply failed, without failing the plan", async () => {
    const run = await runPlan();
    await vi.waitFor(() => expect(handles.has("a")).toBe(true));
    const failing = async (config: RunTurnConfig, cb: RunTurnCallbacks) => {
      cb.setMessages([...config.history, { role: "user", content: config.text, aside: true }]);
      return { ok: false, messages: [], attached: [], error: "Error: fetch failed" };
    };
    const { done } = await startAside("a", env, "Hello?", { turn: failing as any });
    await done;
    const messages = handles.get("a")!.getSession().messages as ChatMessage[];
    expect(messages.at(-1)).toMatchObject({ role: "assistant", aside: true });
    expect(messages.at(-1)!.content).toMatch(/side question failed/i);
    expect(hub.liveRun("a")?.error).toBeUndefined();
    finish("a", "s1");
    finish("a", "s2");
    await run.done;
  });

  it("keeps earlier side questions out of the plan's messages when a new run starts", async () => {
    const old: ChatMessage[] = [
      ...earlier,
      { role: "user", content: "Aside?", aside: true },
      { role: "assistant", content: "Answer.", aside: true },
    ];
    const seen: ChatMessage[][] = [];
    putFile("a", { ...makeSession("a", 1), messages: old, revision: 1 });
    const run = await runners.startRunner("a", env, {
      run: async (cb) => {
        seen.push(cb.messages);
        await fakeRun("a", cb);
      },
      reply: planReply,
      save: (s) => hub.save(s.id, s),
    });
    await vi.waitFor(() => expect(handles.has("a")).toBe(true));
    expect(seen[0].map((m) => m.content)).toEqual(["Make the thing", "Planned."]);
    // The plan writes back its own list; the old side question is still in the session.
    planWrites("a", [...earlier, { role: "user", content: "Do step 1", planStep: "s1" }]);
    expect((handles.get("a")!.getSession().messages as ChatMessage[]).map((m) => m.content)).toEqual([
      "Make the thing",
      "Planned.",
      "Aside?",
      "Answer.",
      "Do step 1",
    ]);
    finish("a", "s1");
    await run.done;
    expect((fileOf("a").messages as ChatMessage[]).filter((m) => m.aside)).toHaveLength(2);
  });
});
