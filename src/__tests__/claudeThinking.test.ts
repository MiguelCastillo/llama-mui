import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";
import { type Effort, type Kind, type ModelOptions, forgetCapabilities } from "../api";
import { modelAnswer } from "./capabilityFixtures";

// A Claude model that supports adaptive thinking thinks on every request of a
// turn (tool rounds, planning replies, steps, checks, side questions and
// background calls included) with the effort the message carries, when the
// model takes it; one that doesn't (Haiku 4.5) gets neither. llama.cpp keeps
// its rule: only the first request of a reply, a plan step, a side question
// or a check, and none while planning or in the background. Checked on the
// request bodies the SDK sends, through the real streamChat; the model's
// capabilities come from the Models API's real answers (capabilityFixtures).

const { mockRunTool } = vi.hoisted(() => ({ mockRunTool: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, runTool: mockRunTool };
});

import { streamChat } from "../api";
import { runTurn } from "../agent/agent";
import { reviewStep } from "../agent/plan";

const start = (id: string) => ({
  type: "message_start",
  message: { id, type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
});
// A reply that calls read_file, then one that ends the turn.
const toolReply = [
  start("m1"),
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];
const endReply = (text: string) => [
  start("m2"),
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

// Answers the replies in order, keeping each request's body.
function serve(replies: object[][]) {
  const bodies: any[] = [];
  vi.stubGlobal("location", { origin: "http://test" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const asked = modelAnswer(String(url), init?.method);
      if (asked) return asked;
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      const events = replies[Math.min(bodies.length - 1, replies.length - 1)];
      const sse = events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }),
  );
  return bodies;
}

const readFile = { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } };

async function turn(
  kind: Kind,
  opts: { modelOptions: ModelOptions; planning: boolean; planStep?: string; aside?: boolean },
  model = "claude-sonnet-5-5",
) {
  const bodies = serve([toolReply, endReply("Done.")]);
  const cb = {
    setMessages: () => {},
    setError: () => {},
    setFailed: () => {},
    setUsage: () => {},
    setAbort: () => {},
    refreshModels: () => {},
    askUser: async () => true,
    todosRef: { current: [] },
    planRef: { current: null },
    planRunningRef: { current: false },
    planAnchor: null,
    planContext: null,
    planSummary: null,
  } as unknown as RunTurnCallbacks;
  const config: RunTurnConfig = {
    connectorId: "c", kind, api: "anthropic", model, toolsOn: true, ...opts,
    systemPrompt: "sys", toolDefinitions: [readFile], toolContextUpdate: "", seenUpdate: "",
    history: [], forgotten: [], workingDir: "/work", attached: [], chatId: "a",
    controller: new AbortController(), started: 0, text: "read the README",
  };
  await runTurn(config, cb);
  return bodies;
}

async function check(kind: Kind, options: ModelOptions, model = "claude-sonnet-5-5") {
  const bodies = serve([toolReply, endReply('{"done": true}')]);
  await reviewStep(
    { connectorId: "c", kind, api: "anthropic", model, options, room: 100000, tools: [readFile], read: async () => "text" },
    "Do it",
    [],
    [],
    [],
    new AbortController().signal,
  );
  return bodies;
}

const ADAPTIVE = { type: "adaptive", display: "summarized" };
const thinkingOf = (bodies: any[]) => bodies.map((b) => b.chat_template_kwargs?.enable_thinking);

beforeEach(() => {
  mockRunTool.mockReset();
  mockRunTool.mockResolvedValue({ result: "# README" });
  forgetCapabilities();
});
afterEach(() => vi.unstubAllGlobals());

describe("a Claude turn on Sonnet 5.5 (adaptive thinking, every effort level)", () => {
  const purposes: [string, { planning: boolean; planStep?: string; aside?: boolean }][] = [
    ["a reply", { planning: false }],
    ["a planning reply", { planning: true }],
    ["a plan step", { planning: false, planStep: "s1" }],
    ["a side question", { planning: false, aside: true }],
  ];
  for (const [name, how] of purposes) {
    it(`thinks on every round of ${name}, with the effort the message carries`, async () => {
      const bodies = await turn("anthropic", { ...how, modelOptions: { think: false, effort: "medium" } });
      expect(bodies.length).toBe(2);
      for (const b of bodies) {
        expect(b.thinking).toEqual(ADAPTIVE);
        expect(b.output_config).toEqual({ effort: "medium" });
        expect(b.chat_template_kwargs).toBeUndefined();
      }
    });
  }

  it("sends no effort when none is set", async () => {
    const bodies = await turn("anthropic", { planning: false, modelOptions: { think: true } });
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(b.thinking).toEqual(ADAPTIVE);
      expect(b.output_config).toBeUndefined();
    }
  });

  it("thinks on every round of a step check too", async () => {
    const bodies = await check("anthropic", { effort: "low" });
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(b.thinking).toEqual(ADAPTIVE);
      expect(b.output_config).toEqual({ effort: "low" });
    }
  });
});

describe("a Claude turn on Haiku 4.5 (no adaptive thinking, no effort)", () => {
  const haiku = "claude-haiku-4-5-20251001";

  it("sends neither thinking nor effort, even if an effort comes with the message", async () => {
    const bodies = await turn("anthropic", { planning: false, modelOptions: { effort: "high" } }, haiku);
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(b.thinking).toBeUndefined();
      expect(b.output_config).toBeUndefined();
      expect(b.chat_template_kwargs).toBeUndefined();
    }
  });

  it("sends neither on a step check", async () => {
    for (const b of await check("anthropic", { effort: "high" }, haiku)) {
      expect(b.thinking).toBeUndefined();
      expect(b.output_config).toBeUndefined();
    }
  });
});

describe("a Claude model whose capabilities can't be read", () => {
  it("is sent nothing optional, rather than something it might refuse", async () => {
    const bodies = await turn("anthropic", { planning: false, modelOptions: { effort: "high" } }, "claude-unknown-1");
    for (const b of bodies) {
      expect(b.thinking).toBeUndefined();
      expect(b.output_config).toBeUndefined();
    }
  });
});

describe("a llama.cpp turn, unchanged", () => {
  const on = { think: true, effort: "high" as Effort };

  it("thinks only on the first request of a chat reply, with Think on", async () => {
    const bodies = await turn("llama", { planning: false, modelOptions: on });
    expect(thinkingOf(bodies)).toEqual([true, false]);
    for (const b of bodies) {
      expect(b.thinking).toBeUndefined();
      expect(b.output_config).toBeUndefined();
    }
  });

  it("never thinks with Think off", async () => {
    expect(thinkingOf(await turn("llama", { planning: false, modelOptions: { think: false } }))).toEqual([false, false]);
    expect(thinkingOf(await turn("llama", { planning: false, modelOptions: {} }))).toEqual([false, false]);
  });

  it("doesn't think while planning", async () => {
    expect(thinkingOf(await turn("llama", { planning: true, modelOptions: on }))).toEqual([false, false]);
  });

  it("thinks on the first request of a plan step", async () => {
    expect(thinkingOf(await turn("llama", { planning: false, planStep: "s1", modelOptions: on }))).toEqual([true, false]);
  });

  it("thinks on the first request of a side question", async () => {
    expect(thinkingOf(await turn("llama", { planning: false, aside: true, modelOptions: on }))).toEqual([true, false]);
  });

  it("thinks only on the first request of a step check", async () => {
    expect(thinkingOf(await check("llama", on))).toEqual([true, false]);
    expect(thinkingOf(await check("llama", { think: false }))).toEqual([false, false]);
  });

  it("doesn't think in the background, whatever the settings", async () => {
    const bodies = serve([endReply("A name")]);
    await streamChat({ connectorId: "c", kind: "llama", api: "anthropic", model: "m", options: on, purpose: { kind: "background" }, messages: [{ role: "user", content: "name it" }] }, () => {}, new AbortController().signal);
    expect(thinkingOf(bodies)).toEqual([false]);
  });
});

describe("a Claude background call", () => {
  it("keeps adaptive thinking, and has no effort, having no settings", async () => {
    const bodies = serve([endReply("A name")]);
    await streamChat({ connectorId: "c", kind: "anthropic", api: "anthropic", model: "claude-sonnet-5-5", purpose: { kind: "background" }, messages: [{ role: "user", content: "name it" }] }, () => {}, new AbortController().signal);
    expect(bodies[0].thinking).toEqual(ADAPTIVE);
    expect(bodies[0].output_config).toBeUndefined();
  });
});
