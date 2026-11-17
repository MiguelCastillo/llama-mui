// The line readers ("taps") the wires offer: each reads what the server's log
// wants (model, token counts, why the reply stopped, an error inside the
// stream, an empty reply) from the lines of its own wire's stream, and keeps
// none of the reply's words. Pure: no React, no I/O, no SDK, so the server's
// log can use them without loading a wire's client.

// What a tap found in a stream.
export interface StreamFacts {
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  // What Anthropic's context editing left out of this request (old tool
  // results, see src/toolResults.ts), when it did.
  clearedToolUses?: number;
  clearedTokens?: number;
  // An error event inside the stream: the provider's error type and message.
  streamError?: { type: string; message: string };
  // Why the reply stopped, when the stream said.
  stopReason?: string;
  // The reply ended with 0 output tokens and no error: the model sent nothing.
  empty?: true;
  // The reply's thinking blocks as they streamed (Messages only): whether each
  // had words and its signature, never the words. The log asks the connection
  // what each is (see classifyThinking in types.ts); this reader judges nothing.
  thinking?: { hasText: boolean; signature?: string }[];
}

// Fed the stream in chunks (which can split a line).
export interface Tap {
  feed(chunk: Buffer | string): void;
  // What was read, or undefined when the stream had no counts and no error.
  result(): StreamFacts | undefined;
}

// Longest provider error message kept in the log.
const MAX_ERROR_MESSAGE = 200;
// A content line can be long, so a partial line longer than this is dropped
// rather than kept.
const MAX_LINE = 64 * 1024;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cutError = (type: unknown, message: unknown) => ({ type: String(type ?? "error").slice(0, 60), message: String(message ?? "").slice(0, MAX_ERROR_MESSAGE) });

// Splits chunks into lines and hands each "data:" line's JSON to `read`, only
// for lines `wants` says can matter (parsing every content line is wasteful).
function lineTap(wants: (line: string, facts: StreamFacts) => boolean, read: (e: any, facts: StreamFacts) => void): Tap {
  const facts: StreamFacts = {};
  let partial = "";
  const take = (line: string) => {
    if (!line.startsWith("data:") || !wants(line, facts)) return;
    let e: any;
    try {
      e = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    read(e, facts);
  };
  return {
    feed(chunk) {
      const lines = (partial + chunk.toString()).split("\n");
      partial = lines.pop() ?? "";
      if (partial.length > MAX_LINE) partial = "";
      for (const line of lines) take(line.trimEnd());
    },
    result() {
      if (partial) take(partial.trimEnd());
      partial = "";
      if (facts.input === undefined && facts.output === undefined && !facts.streamError) return undefined;
      const empty = !facts.streamError && (facts.output ?? 0) === 0;
      return { ...facts, ...(empty ? { empty: true as const } : {}) };
    },
  };
}

// Messages API: message_start carries the model and the input side,
// message_delta the output so far (the last one is the total) and the stop reason.
export const messagesTap = (): Tap => {
  // Thinking blocks by their index in the reply: words seen (not kept) and signature.
  const blocks = new Map<number, { hasText: boolean; signature?: string }>();
  return lineTap(
    (line) =>
      line.includes('"usage"') ||
      line.includes('"applied_edits"') ||
      line.includes('"error"') ||
      line.includes('"stop_reason"') ||
      line.includes('"thinking"') ||
      line.includes('"signature_delta"'),
    (e, facts) => {
      if (e?.type === "error" && e.error) {
        facts.streamError = cutError(e.error.type, e.error.message);
        return;
      }
      if (e?.type === "content_block_start" && e.content_block?.type === "thinking" && typeof e.index === "number") {
        blocks.set(e.index, { hasText: typeof e.content_block.thinking === "string" && e.content_block.thinking.trim() !== "" });
        facts.thinking = [...blocks.values()];
      } else if (e?.type === "content_block_delta" && typeof e.index === "number") {
        const b = blocks.get(e.index);
        if (b && e.delta?.type === "thinking_delta" && typeof e.delta.thinking === "string" && e.delta.thinking.trim() !== "") b.hasText = true;
        else if (b && e.delta?.type === "signature_delta" && typeof e.delta.signature === "string") b.signature = e.delta.signature;
      }
      if (e?.type === "message_delta" && typeof e.delta?.stop_reason === "string") facts.stopReason = e.delta.stop_reason;
      const edits = e?.type === "message_delta" ? e.context_management?.applied_edits : undefined;
      if (Array.isArray(edits) && edits.length) {
        const sum = (key: string) => edits.reduce((n: number, x: any) => n + (typeof x?.[key] === "number" ? x[key] : 0), 0);
        facts.clearedToolUses = sum("cleared_tool_uses");
        facts.clearedTokens = sum("cleared_input_tokens");
      }
      const u = e?.type === "message_start" ? e.message?.usage : e?.type === "message_delta" ? e.usage : undefined;
      if (e?.type === "message_start" && typeof e.message?.model === "string") facts.model = e.message.model;
      if (!u) return;
      facts.input = num(u.input_tokens) ?? facts.input;
      facts.cacheRead = num(u.cache_read_input_tokens) ?? facts.cacheRead;
      facts.cacheWrite = num(u.cache_creation_input_tokens) ?? facts.cacheWrite;
      facts.output = num(u.output_tokens) ?? facts.output;
    },
  );
};

// Chat Completions: the model rides on the first chunk, the stop reason on the
// last chunk with choices, and the counts on a chunk of their own: OpenAI's
// usage, or llama.cpp's timings (which win when both are there). An error
// chunk is {error: {message, type}}.
export const completionsTap = (): Tap =>
  lineTap(
    (line, facts) =>
      facts.model === undefined || line.includes('"usage"') || line.includes('"timings"') || line.includes('"error"') || /"finish_reason"\s*:\s*"/.test(line),
    (e, facts) => {
      if (e?.error && typeof e.error === "object") {
        facts.streamError = cutError(e.error.type, e.error.message);
        return;
      }
      if (typeof e?.model === "string" && e.model) facts.model ??= e.model;
      const finish = e?.choices?.[0]?.finish_reason;
      if (typeof finish === "string") facts.stopReason = finish;
      const t = e?.timings;
      if (t && typeof t.prompt_n === "number") {
        facts.input = t.prompt_n;
        facts.cacheRead = num(t.cache_n) ?? 0;
        facts.output = num(t.predicted_n) ?? 0;
        return;
      }
      const u = e?.usage;
      if (u && typeof u.prompt_tokens === "number") {
        // OpenAI counts cache hits inside prompt_tokens; take them out so
        // input means fresh tokens, as for Messages.
        const cached = num(u.prompt_tokens_details?.cached_tokens) ?? 0;
        facts.input = Math.max(0, u.prompt_tokens - cached);
        facts.cacheRead = cached;
        facts.output = num(u.completion_tokens) ?? 0;
      }
    },
  );

// The tap for a request path, or undefined for a path whose body isn't a
// stream a wire reads.
export function tapForPath(path: string): Tap | undefined {
  if (path === "/v1/messages") return messagesTap();
  if (path === "/v1/chat/completions") return completionsTap();
  return undefined;
}
