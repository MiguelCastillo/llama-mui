// The Completions wire: OpenAI's /v1/chat/completions, which llama.cpp also
// serves. Builds the request and reads the stream into text, reasoning, tool
// calls and usage. Same placeholder key as the Messages wire.
import OpenAI from "openai";
import { type ChatMessage, type ChatReply, type ChatRequest, type StreamDelta, type ToolCall, type Usage, originOf, requestParts, sessionHeaders } from "../../api.ts";
import { connection } from "../index.ts";
import { completionsTap } from "../tap.ts";
import type { Wire } from "../types.ts";

// Converts to the OpenAI wire format, dropping UI-only fields like reasoning.
// `images` maps image ids to base64 data (read per request, never saved).
export function toWire(m: ChatMessage, images?: Record<string, string>) {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.toolCalls?.length) {
    return {
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
  }
  // Build a content array when there are images (OpenAI wants an array of parts).
  if (m.images?.length && images) {
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    for (const img of m.images) {
      const data = images[img.id];
      if (data) {
        parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${data}` } });
      } else {
        parts.push({ type: "text", text: `[Image "${img.id}" missing — the file was deleted or not uploaded]` });
      }
    }
    const text = [m.content, m.update, m.note].filter(Boolean).join("\n\n");
    if (text) parts.push({ type: "text", text });
    return { role: m.role, content: parts };
  }
  return { role: m.role, content: [m.content, m.update, m.note].filter(Boolean).join("\n\n") };
}

// llama.cpp puts a timings block on the last chunk: cache_n tokens reused,
// prompt_n read this turn, predicted_n generated. OpenAI-style usage is the
// fallback for servers that send that instead.
export function readUsage(chunk: any): Usage | undefined {
  const t = chunk.timings;
  if (t && typeof t.prompt_n === "number") {
    return {
      contextTokens: (t.cache_n ?? 0) + t.prompt_n + (t.predicted_n ?? 0),
      tokensPerSecond: t.predicted_per_second,
      promptTokens: t.prompt_n,
      inputTokens: t.prompt_n,
      outputTokens: t.predicted_n ?? 0,
      cacheReadTokens: t.cache_n ?? 0,
    };
  }
  const u = chunk.usage;
  if (u && typeof u.prompt_tokens === "number") {
    // OpenAI counts cache hits inside prompt_tokens; take them out so input
    // means fresh tokens here as for the other providers.
    const cached = u.prompt_tokens_details?.cached_tokens;
    const hit = typeof cached === "number" ? cached : 0;
    return {
      contextTokens: u.prompt_tokens + (u.completion_tokens ?? 0),
      inputTokens: Math.max(0, u.prompt_tokens - hit),
      outputTokens: u.completion_tokens ?? 0,
      ...(typeof cached === "number" ? { cacheReadTokens: hit } : {}),
    };
  }
  return undefined;
}

// Tool calls arrive as fragments spread over many chunks, so they're
// assembled here and returned once the stream ends. The SDK hands chunks over
// as parsed JSON, so llama.cpp's own fields (reasoning_content, timings) are
// there, just not in its types.
export async function streamCompletions(
  { connectorId, kind, model, messages, options, purpose, tools, images }: ChatRequest,
  onDelta: (d: StreamDelta) => void,
  signal: AbortSignal,
): Promise<ChatReply> {
  const conn = connection(kind);
  const client = new OpenAI({
    baseURL: `${originOf()}/api/c/${connectorId}/v1`,
    apiKey: "set-by-the-server",
    defaultHeaders: sessionHeaders(),
    dangerouslyAllowBrowser: true,
    ...(conn.maxRetries === undefined ? {} : { maxRetries: conn.maxRetries }),
  });
  const params = {
    model,
    stream: true,
    messages: messages.map((m) => toWire(m, images)),
    ...(await requestParts(connectorId, kind, model, options, purpose)).fields,
    ...(tools?.length ? { tools } : {}),
  };

  // Keyed by the fragment's index; the id and name come in the first one.
  const calls: ToolCall[] = [];
  let usage: Usage | undefined;
  try {
    const stream = await client.chat.completions.create(params as OpenAI.ChatCompletionCreateParamsStreaming, { signal });
    for await (const chunk of stream as AsyncIterable<any>) {
      usage = readUsage(chunk) ?? usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      for (const f of delta.tool_calls ?? []) {
        const c = (calls[f.index ?? 0] ??= { id: "", name: "", arguments: "" });
        if (f.id) c.id = f.id;
        if (f.function?.name) c.name += f.function.name;
        if (f.function?.arguments) c.arguments += f.function.arguments;
      }
      if (delta.content || delta.reasoning_content) {
        onDelta({ content: delta.content ?? undefined, reasoning: delta.reasoning_content ?? undefined });
      }
    }
  } catch (e) {
    // fetch's own TypeError, which failureLine reads as "couldn't reach".
    if (e instanceof OpenAI.APIConnectionError && e.cause instanceof TypeError) throw e.cause;
    if (e instanceof OpenAI.APIError && e.status) {
      throw new Error(`POST /v1/chat/completions: ${e.status} ${conn.errorMessage(e.error, e.message)}`);
    }
    throw e;
  }
  // Tool results must reference an id, so make one up if the server sent none.
  return { toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` })), usage };
}

export const completionsWire: Wire = {
  name: "openai",
  path: "/v1/chat/completions",
  tap: completionsTap,
  stream: (req, onDelta, signal) => streamCompletions(req, onDelta, signal),
};
