// The Messages wire: Anthropic's /v1/messages, which Claude and llama.cpp both
// serve. Builds the request and reads the stream into text, thinking, tool
// calls and usage. The SDK's key is a placeholder: the dev server's proxy
// replaces it with the connector's, which is why it's safe in a browser.
import Anthropic from "@anthropic-ai/sdk";
import { type ChatReply, type ChatRequest, type StreamDelta, type ToolCall, originOf, requestParts, sessionHeaders, toMessages } from "../../api.ts";
import { connection } from "../index.ts";
import { messagesTap } from "../tap.ts";
import type { Wire } from "../types.ts";

// The Messages API requires a cap. Big enough for a step that writes a whole
// file; llama.cpp stops sooner when the context fills.
export const MAX_TOKENS = 32768;

// Wording that failureLine (src/agent/helpers.ts) recognises.
export const STREAM_ERROR = "Stream error";
export const EMPTY_REPLY = "The model sent nothing";

// The tools' definitions are OpenAI-shaped (see fn in server/toolkit.ts).
function toTool(t: any): Anthropic.Tool {
  const f = t.function ?? t;
  return { name: f.name, description: f.description, input_schema: f.parameters ?? f.input_schema };
}

// A thinking block whose signature decodes to "narration" holds words the
// model wrote before a tool call, which belong in the reply.
export function isNarration(signature?: string): boolean {
  if (!signature) return false;
  try {
    return atob(signature) === "narration";
  } catch {
    return false;
  }
}

export async function streamMessages(
  { connectorId, kind, model, messages, options, purpose, tools, images }: ChatRequest,
  onDelta: (d: StreamDelta) => void,
  signal: AbortSignal,
  // How many of the newest tool results go whole, for a server that clears the rest.
  keepToolResults?: number,
): Promise<ChatReply> {
  const conn = connection(kind);
  const client = new Anthropic({
    baseURL: `${originOf()}/api/c/${connectorId}`,
    apiKey: "set-by-the-server",
    defaultHeaders: sessionHeaders(),
    dangerouslyAllowBrowser: true,
    // The SDK retries only failed requests, never a stream under way; how
    // often is the connection's say.
    ...(conn.maxRetries === undefined ? {} : { maxRetries: conn.maxRetries }),
  });
  const { system, messages: wire } = toMessages(messages, images);
  const extra = await requestParts(connectorId, kind, model, options, purpose, keepToolResults);
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    messages: wire,
    ...(system ? { system } : {}),
    ...(tools?.length ? { tools: tools.map(toTool) } : {}),
    ...extra.fields,
  };

  const calls = new Map<number, ToolCall>();
  const thinking = new Map<number, string>();
  const signatures = new Map<number, string>();
  let final: Anthropic.Message | undefined;
  let input = 0;
  let cached = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  // What Anthropic's context editing left out (old tool results).
  let clearedResults = 0;
  let clearedTokens = 0;
  try {
    final = await readStream(params);
  } catch (e) {
    // fetch's own TypeError, which failureLine reads as "couldn't reach".
    if (e instanceof Anthropic.APIConnectionError && e.cause instanceof TypeError) throw e.cause;
    if (e instanceof Anthropic.APIError && e.status) {
      throw new Error(`POST /v1/messages: ${e.status} ${conn.errorMessage(e.error, e.message)}`);
    }
    // An error event inside a stream that started fine (e.g. overloaded_error)
    // has no HTTP status; keep the provider's type and message.
    if (e instanceof Anthropic.APIError) {
      const type = (e.error as any)?.error?.type;
      throw new Error(`${STREAM_ERROR} (${type ?? "unknown"}): ${conn.errorMessage(e.error, e.message)}`);
    }
    throw e;
  }

  async function readStream(body: object): Promise<Anthropic.Message> {
    const stream = client.messages.stream(body as Anthropic.MessageStreamParams, { signal, headers: extra.headers });
    for await (const event of stream) {
      if (event.type === "message_start") {
        input = event.message.usage.input_tokens ?? 0;
        cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
        cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
        cached = cacheRead + cacheWrite;
      } else if (event.type === "message_delta") {
        output = event.usage.output_tokens ?? output;
        const edits = (event as any).context_management?.applied_edits;
        if (Array.isArray(edits)) {
          for (const e of edits) {
            clearedResults += typeof e?.cleared_tool_uses === "number" ? e.cleared_tool_uses : 0;
            clearedTokens += typeof e?.cleared_input_tokens === "number" ? e.cleared_input_tokens : 0;
          }
        }
      } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: "" });
      } else if (event.type === "content_block_stop" && thinking.has(event.index)) {
        // The provider marks narration only in the signature, which comes last,
        // so a thinking block is held until it closes and then sent as reply
        // text (narration) or as reasoning.
        const words = thinking.get(event.index)!;
        thinking.delete(event.index);
        onDelta(isNarration(signatures.get(event.index)) ? { content: words } : { reasoning: words });
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d.type === "text_delta") onDelta({ content: d.text });
        else if (d.type === "thinking_delta") thinking.set(event.index, (thinking.get(event.index) ?? "") + d.thinking);
        else if (d.type === "signature_delta") signatures.set(event.index, d.signature);
        else if (d.type === "input_json_delta") {
          const c = calls.get(event.index);
          if (c) c.arguments += d.partial_json;
        }
      }
    }
    return stream.finalMessage();
  }
  // Claude's safety checks can stop a reply partway; without this it would
  // just end, maybe empty.
  if (final.stop_reason === "refusal") {
    const category = (final as any).stop_details?.category;
    throw new Error(`The model declined to answer${category ? ` (${category})` : ""}.`);
  }
  // A reply with no text, thinking or calls is a failure, not a quiet success.
  if (!final.content.some((b) => (b.type === "text" ? b.text.trim() : true))) {
    throw new Error(`${EMPTY_REPLY}${final.stop_reason ? ` (stop reason: ${final.stop_reason})` : ""}.`);
  }
  // llama.cpp signs nothing (an empty signature), so only Claude's replies
  // need their blocks kept.
  const signed = final.content.some((b) => b.type === "redacted_thinking" || (b.type === "thinking" && b.signature));
  return {
    toolCalls: [...calls.values()].map((c, i) => ({ ...c, id: c.id || `call_${i}`, arguments: c.arguments || "{}" })),
    usage: input || cached || output ? {
          contextTokens: input + cached + output,
          promptTokens: input,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          ...(clearedResults ? { clearedResults, clearedTokens } : {}),
        }
      : undefined,
    ...(signed ? { blocks: final.content as Anthropic.ContentBlockParam[] } : {}),
  };
}

export const messagesWire: Wire = {
  name: "anthropic",
  path: "/v1/messages",
  tap: messagesTap,
  stream: (req, onDelta, signal, ctx) => streamMessages(req, onDelta, signal, ctx?.keepToolResults),
};
