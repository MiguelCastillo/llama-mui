import { afterEach, describe, it, expect, vi } from "vitest";
import { modelAnswer } from "./capabilityFixtures";
import { type Effort, streamChat, toMessages, type ChatMessage, type ImageRef, type StreamDelta, type ToolCall } from "../api";

// ── helpers ──────────────────────────────────────────────────────────────────

function tc(name: string, args: object, id = "call_x"): ToolCall {
  return { name, arguments: JSON.stringify(args), id };
}

// ── toMessages: empty ────────────────────────────────────────────────────────

describe("toMessages", () => {
  it("returns empty messages and no system for an empty history", () => {
    const result = toMessages([]);
    expect(result.system).toBeUndefined();
    expect(result.messages).toEqual([]);
  });

  // ── system prompt ──────────────────────────────────────────────────────────

  it("collects system messages into a single system string", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
    ];
    const result = toMessages(history);
    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toEqual([]);
  });

  it("joins multiple system messages with double newlines", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "Be concise." },
      { role: "system", content: "No pleasantries." },
    ];
    const result = toMessages(history);
    expect(result.system).toBe("Be concise.\n\nNo pleasantries.");
  });

  // ── user messages ──────────────────────────────────────────────────────────

  it("converts a user message to a text block", () => {
    const history: ChatMessage[] = [{ role: "user", content: "Hello" }];
    const result = toMessages(history);
    expect(result.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);
  });

  it("does not send the response a user message replies to", () => {
    const plain: ChatMessage[] = [
      { role: "assistant", content: "Use a map." },
      { role: "user", content: "Why a map?" },
    ];
    const replying: ChatMessage[] = [
      plain[0],
      { role: "user", content: "Why a map?", replyTo: { text: "Use a map, not a list, for lookups." } },
    ];
    const result = toMessages(replying);
    expect(result).toEqual(toMessages(plain));
    expect(JSON.stringify(result)).not.toContain("not a list");
  });

  it("appends update and note to user text", () => {
    const history: ChatMessage[] = [
      {
        role: "user",
        content: "Fix the bug",
        update: "Chat update: tests pass",
        note: "Planning note",
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("Fix the bug\n\nChat update: tests pass\n\nPlanning note");
  });

  // ── assistant messages ─────────────────────────────────────────────────────

  it("converts an assistant message with content to a text block", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "Sure thing" }];
    const result = toMessages(history);
    expect(result.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Sure thing" }] },
    ]);
  });

  it("sends a reply's kept blocks back as they were", () => {
    const kept = [
      { type: "thinking" as const, thinking: "Let me think...", signature: "sig1" },
      { type: "text" as const, text: "Answer" },
      { type: "thinking" as const, thinking: "And more.", signature: "sig2" },
    ];
    const history: ChatMessage[] = [{ role: "assistant", content: "Answer", reasoning: "Let me think...And more.", blocks: kept }];
    expect(toMessages(history).messages).toEqual([{ role: "assistant", content: kept }]);
  });

  it("leaves thinking out when no blocks were kept", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "Answer", reasoning: "Let me think..." },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("Answer");
    expect(blocks.length).toBe(1);
  });

  it("adds tool_use blocks for tool calls", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [tc("read_file", { path: "a.txt" })],
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe("tool_use");
    expect(blocks[0].id).toBe("call_x");
    expect(blocks[0].name).toBe("read_file");
    expect(blocks[0].input).toEqual({ path: "a.txt" });
  });

  it("handles broken JSON in tool arguments", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "read_file", arguments: "not json", id: "call_y" }],
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].input).toEqual({ input: "not json" });
  });

  it("handles empty arguments as {}", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "read_file", arguments: "", id: "call_z" }],
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].input).toEqual({});
  });

  it("puts the text before the tool calls", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "Done", reasoning: "Thinking", toolCalls: [tc("read_file", { path: "a.txt" })] },
    ];
    const blocks = toMessages(history).messages[0].content as any[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  // ── tool messages ──────────────────────────────────────────────────────────

  it("converts a tool result to a tool_result block", () => {
    const history: ChatMessage[] = [
      {
        role: "tool",
        content: "file contents",
        toolCallId: "call_x",
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("call_x");
    expect(blocks[0].content).toBe("file contents");
  });

  // ── turn alternation ───────────────────────────────────────────────────────

  it("keeps assistant blocks in one message, tool results in the next user message", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "Let me check", toolCalls: [tc("read_file", { path: "a.txt" })] },
      { role: "tool", content: "file contents", toolCallId: "call_x" },
    ];
    const result = toMessages(history);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[1].role).toBe("user");
  });

  it("appends to an existing assistant message when consecutive", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "First" },
      { role: "assistant", content: "Second" },
    ];
    const result = toMessages(history);
    expect(result.messages.length).toBe(1);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].text).toBe("First");
    expect(blocks[1].text).toBe("Second");
  });

  it("appends to an existing user message when consecutive", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "First" },
      { role: "user", content: "Second" },
    ];
    const result = toMessages(history);
    expect(result.messages.length).toBe(1);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].text).toBe("First");
    expect(blocks[1].text).toBe("Second");
  });

  // ── full conversation ──────────────────────────────────────────────────────

  it("handles a complete conversation with system, user, assistant, tool", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Read a.txt" },
      {
        role: "assistant",
        content: "",
        reasoning: "I'll read the file.",
        toolCalls: [tc("read_file", { path: "a.txt" })],
      },
      { role: "tool", content: "file contents here", toolCallId: "call_x" },
      { role: "assistant", content: "The file says hello." },
    ];
    const result = toMessages(history);
    expect(result.system).toBe("You are a coding assistant.");
    expect(result.messages.length).toBe(4);
    // 1: user
    // 2: assistant (thinking + tool_use)
    // 3: user (tool_result)
    // 4: assistant (text)
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("user");
    expect(result.messages[3].role).toBe("assistant");
  });

  // ── edge cases ─────────────────────────────────────────────────────────────

  it("skips empty assistant content blocks", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "" }];
    const result = toMessages(history);
    expect(result.messages).toEqual([]);
  });

  it("skips empty user content blocks", () => {
    const history: ChatMessage[] = [{ role: "user", content: "" }];
    const result = toMessages(history);
    expect(result.messages).toEqual([]);
  });

  it("skips user message when content, update, and note are all empty", () => {
    const history: ChatMessage[] = [{ role: "user", content: "", update: "", note: "" }];
    const result = toMessages(history);
    expect(result.messages).toEqual([]);
  });

  it("skips an assistant message that has only reasoning and no kept blocks", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "", reasoning: "thinking" }];
    const result = toMessages(history);
    expect(result.messages).toEqual([]);
  });

  // ── tool_use with complex input ────────────────────────────────────────────

  it("parses nested JSON in tool arguments", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            name: "update_plan",
            arguments: JSON.stringify({ steps: [{ text: "Do thing", status: "pending" }] }),
            id: "call_nested",
          },
        ],
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].input).toEqual({
      steps: [{ text: "Do thing", status: "pending" }],
    });
  });
});

// ── parseInput (internal helper) via toMessages ──────────────────────────────

describe("parseInput behavior via toMessages", () => {
  it("treats a JSON array as { input: <raw string> }", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "tool", arguments: "[1, 2]", id: "c1" }],
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].input).toEqual({ input: "[1, 2]" });
  });

  it("treats a JSON string as { input: <raw string> }", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "tool", arguments: '"hello"', id: "c1" }],
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].input).toEqual({ input: '"hello"' });
  });

  it("treats a JSON number as { input: <raw string> }", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "tool", arguments: "42", id: "c1" }],
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].input).toEqual({ input: "42" });
  });

  it("treats null JSON as { input: \"null\" }", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "tool", arguments: "null", id: "c1" }],
      },
    ];
    const result = toMessages(history);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].input).toEqual({ input: "null" });
  });
});

// ── streamChat, against a recorded stream ───────────────────────────────────

// Serves `events` as one server-sent-events response to every fetch, and
// keeps the requests so a test can check what was sent.
function serve(events: object[], status = 200) {
  const requests: { url: string; body: any }[] = [];
  // The Anthropic SDK reads each event's name from its `event:` line.
  const sse = events.map((e: any) => `${e.type ? `event: ${e.type}\n` : ""}data: ${JSON.stringify(e)}\n\n`).join("");
  vi.stubGlobal("location", { origin: "http://test" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const asked = modelAnswer(String(url instanceof Request ? url.url : url), init?.method);
      if (asked) return asked;
      requests.push({ url: String(url instanceof Request ? url.url : url), body: JSON.parse(String(init?.body ?? "{}")) });
      return status === 200
        ? new Response(sse, { headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify(events[0]), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return requests;
}

const tool = { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } };
const request = { connectorId: "c1", model: "qwen", purpose: { kind: "reply" as const, round: 0 }, tools: [tool], messages: [{ role: "user" as const, content: "Read README.md" }] };

async function collect(api: "anthropic" | "openai", kind: "llama" | "anthropic" = "llama", think = true, effort?: Effort, model = "claude-sonnet-5-5") {
  const deltas: StreamDelta[] = [];
  const reply = await streamChat({ ...request, api, kind, model: kind === "anthropic" ? model : request.model, options: { think, effort } }, (d) => deltas.push(d), new AbortController().signal);
  return { reply, text: deltas.map((d) => d.content ?? "").join(""), reasoning: deltas.map((d) => d.reasoning ?? "").join("") };
}

afterEach(() => vi.unstubAllGlobals());

// A history cut off while a tool call waited: the call has no result.
const orphanHistory: ChatMessage[] = [
  { role: "user", content: "Read README.md" },
  { role: "assistant", content: "Reading it.", toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"README.md"}' }] },
  { role: "user", content: "Are you there?" },
];
const cutOff = "This call did not run: it was cut off before it finished (the page was reloaded while it waited).";

describe("streamChat with a tool call that never got a result", () => {
  const send = (api: "anthropic" | "openai") =>
    streamChat({ ...request, api, kind: "llama", messages: orphanHistory }, () => {}, new AbortController().signal);

  it("sends a tool_result for it with the Messages API", async () => {
    const requests = serve([
      { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "qwen", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    await send("anthropic");
    const sent = requests[0].body.messages;
    expect(sent[1].content.some((b: any) => b.type === "tool_use" && b.id === "t1")).toBe(true);
    // The result comes first in the next user message, ahead of the user's own text.
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: cutOff });
  });

  it("sends a tool message for it with the Chat Completions API", async () => {
    const requests = serve([{ choices: [{ delta: {} }] }]);
    await send("openai");
    const sent = requests[0].body.messages;
    const i = sent.findIndex((m: any) => m.role === "assistant" && m.tool_calls);
    expect(sent[i + 1]).toEqual({ role: "tool", tool_call_id: "t1", content: cutOff });
  });

  it("leaves the caller's history untouched", async () => {
    serve([{ choices: [{ delta: {} }] }]);
    await send("openai");
    expect(orphanHistory).toHaveLength(3);
  });
});

// A reply that ended with an action item and an idea, then the user's "go ahead".
// The boxes under the reply are kept on it for display; the model must only see
// the calls it made and their "Shown to the user." answers.
const noteCalls: ToolCall[] = [
  { id: "n1", name: "add_action_item", arguments: '{"text":"Restart the server","can_do":true}' },
  { id: "n2", name: "add_idea", arguments: '{"text":"Cache the lookup"}' },
];
const noteHistory: ChatMessage[] = [
  { role: "user", content: "Why is it slow?" },
  {
    role: "assistant",
    content: "The lookup runs twice.",
    toolCalls: noteCalls,
    notes: [
      { kind: "action", text: "Restart the server", canDo: true, done: true },
      { kind: "idea", text: "Cache the lookup" },
    ],
  },
  { role: "tool", content: "Shown to the user.", toolCallId: "n1" },
  { role: "tool", content: "Shown to the user.", toolCallId: "n2" },
  { role: "user", content: "yes, go ahead" },
];
const noteFields = ['"notes"', '"canDo"', '"done"', '"kind"'];

describe("streamChat after a reply that made a note call", () => {
  const send = (api: "anthropic" | "openai") =>
    streamChat({ ...request, api, kind: "llama", messages: noteHistory }, () => {}, new AbortController().signal);

  it("sends the reply's text, its calls and their answers with the Messages API, and no note fields", async () => {
    const requests = serve([
      { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "qwen", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    await send("anthropic");
    const sent = requests[0].body.messages;
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toEqual([
      { type: "text", text: "The lookup runs twice." },
      { type: "tool_use", id: "n1", name: "add_action_item", input: { text: "Restart the server", can_do: true } },
      { type: "tool_use", id: "n2", name: "add_idea", input: { text: "Cache the lookup" } },
    ]);
    // Both answers come back together in the next user turn, ahead of anything else.
    expect(sent[2].role).toBe("user");
    expect(sent[2].content.slice(0, 2)).toEqual([
      { type: "tool_result", tool_use_id: "n1", content: "Shown to the user." },
      { type: "tool_result", tool_use_id: "n2", content: "Shown to the user." },
    ]);
    expect(sent[sent.length - 1].content.at(-1)).toEqual({ type: "text", text: "yes, go ahead" });
    const text = JSON.stringify(sent);
    for (const field of noteFields) expect(text).not.toContain(field);
  });

  it("sends the same with the Chat Completions API, and no note fields", async () => {
    const requests = serve([{ choices: [{ delta: {} }] }]);
    await send("openai");
    const sent = requests[0].body.messages;
    expect(sent[1]).toEqual({
      role: "assistant",
      content: "The lookup runs twice.",
      tool_calls: [
        { id: "n1", type: "function", function: { name: "add_action_item", arguments: '{"text":"Restart the server","can_do":true}' } },
        { id: "n2", type: "function", function: { name: "add_idea", arguments: '{"text":"Cache the lookup"}' } },
      ],
    });
    expect(sent[2]).toEqual({ role: "tool", tool_call_id: "n1", content: "Shown to the user." });
    expect(sent[3]).toEqual({ role: "tool", tool_call_id: "n2", content: "Shown to the user." });
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "yes, go ahead" });
    const text = JSON.stringify(sent);
    for (const field of noteFields) expect(text).not.toContain(field);
  });
});

describe("streamChat with the Messages API", () => {
  // A reply that thinks, says something and calls a tool. llama.cpp's
  // signature is empty; Claude's isn't.
  const reply = (signature: string, stop = "tool_use") => [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "qwen", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Need the file." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading it." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"README.md"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, ...(stop === "refusal" && { stop_details: { type: "refusal", category: "cyber" } }) }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];

  it("returns the text, thinking, tool call and usage it streamed", async () => {
    serve(reply(""));
    const { reply: r, text, reasoning } = await collect("anthropic");
    expect(text).toBe("Reading it.");
    expect(reasoning).toBe("Need the file.");
    expect(r.toolCalls).toEqual([{ id: "t1", name: "read_file", arguments: '{"path":"README.md"}' }]);
    expect(r.usage).toEqual({ contextTokens: 105, promptTokens: 10 });
  });

  it("keeps no blocks for a llama.cpp reply, whose thinking is unsigned", async () => {
    serve(reply(""));
    expect((await collect("anthropic")).reply.blocks).toBeUndefined();
  });

  it("keeps a signed reply's blocks as the API returned them", async () => {
    serve(reply("sig"));
    expect((await collect("anthropic", "anthropic")).reply.blocks).toEqual([
      { type: "thinking", thinking: "Need the file.", signature: "sig" },
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "README.md" } },
    ]);
  });

  it("posts a llama server's request with the tools converted and chat_template_kwargs", async () => {
    const requests = serve(reply(""));
    await collect("anthropic");
    expect(requests[0].url).toBe("http://test/api/c/c1/v1/messages");
    expect(requests[0].body.tools).toEqual([{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }]);
    expect(requests[0].body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(requests[0].body.max_tokens).toBeGreaterThan(0);
    expect(requests[0].body.thinking).toBeUndefined();
    expect(requests[0].body.cache_control).toBeUndefined();
  });

  it("sends a llama server no effort, even when one is given", async () => {
    const requests = serve(reply(""));
    await collect("anthropic", "llama", false, "high");
    expect(requests[0].body.output_config).toBeUndefined();
    expect(requests[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("posts Anthropic's request with adaptive thinking and caching, not chat_template_kwargs", async () => {
    const requests = serve(reply("sig"));
    await collect("anthropic", "anthropic");
    expect(requests[0].body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(requests[0].body.cache_control).toEqual({ type: "ephemeral" });
    expect(requests[0].body.chat_template_kwargs).toBeUndefined();
  });

  it("asks Claude to think with Think off too: Claude has no off switch", async () => {
    const requests = serve(reply("sig", "end_turn"));
    await collect("anthropic", "anthropic", false);
    expect(requests[0].body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("sends a Claude model that can't think adaptively, or take effort, neither (Haiku 4.5)", async () => {
    const requests = serve(reply("", "end_turn"));
    await collect("anthropic", "anthropic", true, "high", "claude-haiku-4-5-20251001");
    expect(requests[0].body.thinking).toBeUndefined();
    expect(requests[0].body.output_config).toBeUndefined();
    expect(requests[0].body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends Claude the effort when one is set, and none when it's the default", async () => {
    const withEffort = serve(reply("sig", "end_turn"));
    await collect("anthropic", "anthropic", true, "xhigh");
    expect(withEffort[0].body.output_config).toEqual({ effort: "xhigh" });
    const without = serve(reply("sig", "end_turn"));
    await collect("anthropic", "anthropic");
    expect(without[0].body.output_config).toBeUndefined();
  });

  it("says so when the model declines", async () => {
    serve(reply("sig", "refusal"));
    await expect(collect("anthropic", "anthropic")).rejects.toThrow("The model declined to answer (cyber).");
  });

  it("reports llama.cpp's error message with the status", async () => {
    serve([{ error: { code: 400, message: "model 'qwen' not found", type: "invalid_request_error" } }], 400);
    await expect(collect("anthropic")).rejects.toThrow("POST /v1/messages: 400 model 'qwen' not found");
  });

  it("reports Anthropic's error message with the status", async () => {
    serve([{ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }], 401);
    await expect(collect("anthropic", "anthropic")).rejects.toThrow("POST /v1/messages: 401 invalid x-api-key");
  });
});

describe("streamChat with the Chat Completions API", () => {
  const chunks = [
    { choices: [{ delta: { reasoning_content: "Need the file." } }] },
    { choices: [{ delta: { content: "Reading it." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read_file", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
    { choices: [{ delta: {} }], timings: { cache_n: 90, prompt_n: 10, predicted_n: 5, predicted_per_second: 42 } },
  ];

  it("returns the text, thinking, tool call and llama.cpp's timings it streamed", async () => {
    serve(chunks);
    const { reply, text, reasoning } = await collect("openai");
    expect(text).toBe("Reading it.");
    expect(reasoning).toBe("Need the file.");
    expect(reply.blocks).toBeUndefined();
    expect(reply.toolCalls).toEqual([{ id: "t1", name: "read_file", arguments: '{"path":"README.md"}' }]);
    expect(reply.usage).toEqual({ contextTokens: 105, tokensPerSecond: 42, promptTokens: 10 });
  });

  it("posts to the connector's /v1/chat/completions with the tools as they are", async () => {
    const requests = serve(chunks);
    await collect("openai");
    expect(requests[0].url).toBe("http://test/api/c/c1/v1/chat/completions");
    expect(requests[0].body.tools).toEqual([tool]);
    expect(requests[0].body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("reports llama.cpp's error message with the status", async () => {
    serve([{ error: { code: 400, message: "model 'qwen' not found", type: "invalid_request_error" } }], 400);
    await expect(collect("openai")).rejects.toThrow("POST /v1/chat/completions: 400 model 'qwen' not found");
  });
});

// ── toWire (OpenAI/llama.cpp) with images ───────────────────────────────────

describe("toWire with images via streamChat (openai)", () => {
  const chunks = [
    { choices: [{ delta: { reasoning_content: "Need the file." } }] },
    { choices: [{ delta: { content: "Reading it." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read_file", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
    { choices: [{ delta: {} }], timings: { cache_n: 90, prompt_n: 10, predicted_n: 5, predicted_per_second: 42 } },
  ];

  it("posts image_url data URLs for images with base64 data", async () => {
    const requests = serve(chunks);
    const imageHistory: ChatMessage[] = [
      {
        role: "user",
        content: "What is this?",
        images: [{ id: "img-1", mediaType: "image/png" }, { id: "img-2", mediaType: "image/jpeg" }],
      },
    ];
    await streamChat(
      { ...request, api: "openai", kind: "llama", messages: imageHistory, images: { "img-1": "iVBORw0KGgo=", "img-2": "/9j/4AAQSkZJRg==" } },
      () => {},
      new AbortController().signal,
    );
    const sent = requests[0].body.messages;
    const userMsg = sent[0];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } },
      { type: "text", text: "What is this?" },
    ]);
  });

  it("posts a text note for an image whose base64 data is missing", async () => {
    const requests = serve(chunks);
    const imageHistory: ChatMessage[] = [
      {
        role: "user",
        content: "What is this?",
        images: [{ id: "img-1", mediaType: "image/png" }],
      },
    ];
    await streamChat(
      { ...request, api: "openai", kind: "llama", messages: imageHistory, images: {} },
      () => {},
      new AbortController().signal,
    );
    const sent = requests[0].body.messages;
    const userMsg = sent[0];
    expect(userMsg.content).toEqual([
      { type: "text", text: '[Image "img-1" missing — the file was deleted or not uploaded]' },
      { type: "text", text: "What is this?" },
    ]);
  });

  it("posts only a text part when there are no images", async () => {
    const requests = serve(chunks);
    const history: ChatMessage[] = [{ role: "user", content: "Hello" }];
    await streamChat(
      { ...request, api: "openai", kind: "llama", messages: history },
      () => {},
      new AbortController().signal,
    );
    const sent = requests[0].body.messages;
    expect(sent[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("posts image_url plus text when content is empty but images exist", async () => {
    const requests = serve(chunks);
    const imageHistory: ChatMessage[] = [
      {
        role: "user",
        content: "",
        images: [{ id: "img-1", mediaType: "image/png" }],
      },
    ];
    await streamChat(
      { ...request, api: "openai", kind: "llama", messages: imageHistory, images: { "img-1": "iVBORw0KGgo=" } },
      () => {},
      new AbortController().signal,
    );
    const sent = requests[0].body.messages;
    const userMsg = sent[0];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
  });
});

// ── ImageRef and toMessages with images ──────────────────────────────────────

describe("ImageRef type", () => {
  it("is a plain object with id and mediaType", () => {
    const ref: ImageRef = { id: "abc-123", mediaType: "image/png" };
    expect(ref.id).toBe("abc-123");
    expect(ref.mediaType).toBe("image/png");
  });
});

describe("toMessages with images", () => {
  it("keeps images on the user message but does not emit image blocks (base64 is read per request)", () => {
    const images: ImageRef[] = [{ id: "img-1", mediaType: "image/png" }];
    const history: ChatMessage[] = [{ role: "user", content: "What is this?", images }];
    const result = toMessages(history);
    // toMessages converts text/update/note into a text block; images are
    // read per request and passed separately (never saved into the session).
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("What is this?");
  });

  it("leaves images on the message when content is empty", () => {
    const images: ImageRef[] = [{ id: "img-1", mediaType: "image/jpeg" }];
    const history: ChatMessage[] = [{ role: "user", content: "", images }];
    const result = toMessages(history);
    // No text/update/note → no blocks → the message is skipped.
    // Images stay on the message; the wire step reads them per request.
    expect(result.messages).toEqual([]);
  });

  it("emits image blocks before the text block when images data is provided", () => {
    const images: ImageRef[] = [
      { id: "img-1", mediaType: "image/png" },
      { id: "img-2", mediaType: "image/jpeg" },
    ];
    const history: ChatMessage[] = [{ role: "user", content: "What is this?", images }];
    const base64Images: Record<string, string> = {
      "img-1": "iVBORw0KGgo=",
      "img-2": "/9j/4AAQSkZJRg==",
    };
    const result = toMessages(history, base64Images);
    const blocks = result.messages[0].content as any[];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
    });
    expect(blocks[2]).toEqual({ type: "text", text: "What is this?" });
  });

  it("emits a text note for an image whose base64 data is missing", () => {
    const images: ImageRef[] = [{ id: "img-1", mediaType: "image/png" }];
    const history: ChatMessage[] = [{ role: "user", content: "What is this?", images }];
    // No data for "img-1"
    const base64Images: Record<string, string> = {};
    const result = toMessages(history, base64Images);
    const blocks = result.messages[0].content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "text",
      text: '[Image "img-1" missing — the file was deleted or not uploaded]',
    });
    expect(blocks[1]).toEqual({ type: "text", text: "What is this?" });
  });

  it("skips images whose data is missing but keeps the ones that are present", () => {
    const images: ImageRef[] = [
      { id: "img-1", mediaType: "image/png" },
      { id: "img-2", mediaType: "image/jpeg" },
    ];
    const history: ChatMessage[] = [{ role: "user", content: "What is this?", images }];
    // Only img-2 has data
    const base64Images: Record<string, string> = { "img-2": "/9j/4AAQSkZJRg==" };
    const result = toMessages(history, base64Images);
    const blocks = result.messages[0].content as any[];
    expect(blocks).toHaveLength(3);
    // Missing image becomes a text note
    expect(blocks[0]).toEqual({
      type: "text",
      text: '[Image "img-1" missing — the file was deleted or not uploaded]',
    });
    // Present image becomes an image block
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
    });
    expect(blocks[2]).toEqual({ type: "text", text: "What is this?" });
  });

  it("puts image blocks before text/update/note combined text", () => {
    const images: ImageRef[] = [{ id: "img-1", mediaType: "image/png" }];
    const history: ChatMessage[] = [
      { role: "user", content: "Fix this", update: "Chat update: new error", note: "Planning note", images },
    ];
    const base64Images: Record<string, string> = { "img-1": "iVBORw0KGgo=" };
    const result = toMessages(history, base64Images);
    const blocks = result.messages[0].content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toBe("Fix this\n\nChat update: new error\n\nPlanning note");
  });

  it("emits only image blocks when content, update, and note are all empty", () => {
    const images: ImageRef[] = [{ id: "img-1", mediaType: "image/png" }];
    const history: ChatMessage[] = [{ role: "user", content: "", update: "", note: "", images }];
    const base64Images: Record<string, string> = { "img-1": "iVBORw0KGgo=" };
    const result = toMessages(history, base64Images);
    expect(result.messages).toHaveLength(1);
    const blocks = result.messages[0].content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("does not emit image blocks when images data map is undefined", () => {
    const images: ImageRef[] = [{ id: "img-1", mediaType: "image/png" }];
    const history: ChatMessage[] = [{ role: "user", content: "What is this?", images }];
    const result = toMessages(history, undefined);
    const blocks = result.messages[0].content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "text", text: "What is this?" });
  });
});

