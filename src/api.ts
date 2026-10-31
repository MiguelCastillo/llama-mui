// Client for the dev server's /api routes: settings (connectors and
// directories), the file tools, and llama.cpp's OpenAI-compatible API proxied
// per connector at /api/c/<id>/v1. The dev server adds each connector's key,
// so none of this code ever sees one.

export type ModelStatus = "loaded" | "loading" | "unloaded" | string;

export interface Model {
  id: string;
  status: ModelStatus;
  inputs: string[];
  // Tokens the server gives this model's context, when it says.
  contextSize?: number;
}

// llama.cpp starts each model with --ctx-size, which can be smaller than what
// the model supports (context_length). A loaded model reports the real value
// as meta.n_ctx; for unloaded ones, the start-up args are the best guess.
function contextSize(m: any): number | undefined {
  const args: string[] = m.status?.args ?? [];
  const i = args.indexOf("--ctx-size");
  const fromArgs = i >= 0 ? Number(args[i + 1]) : NaN;
  return m.meta?.n_ctx ?? (fromArgs > 0 ? fromArgs : undefined) ?? m.context_length;
}

export interface ToolCall {
  id: string;
  name: string;
  // JSON text, exactly as the model produced it.
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Thinking tokens that Qwen-style models stream separately from the answer.
  reasoning?: string;
  // Set on assistant messages that asked to run tools.
  toolCalls?: ToolCall[];
  // Set on tool messages: which call this is the result of.
  toolCallId?: string;
  // How long a step took and roughly how many tokens it used, for display.
  // On assistant messages it covers the thinking; on tool messages, the run.
  stats?: StepStats;
}

export interface StepStats {
  ms: number;
  // Approximate: thinking counts streamed pieces (about one token each); a
  // tool result gets its share of the tokens the next turn had to read.
  tokens?: number;
}

// Converts to the OpenAI wire format, dropping UI-only fields like reasoning.
function toWire(m: ChatMessage) {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.toolCalls?.length) {
    return {
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content: m.content };
}

export interface Connector {
  id: string;
  name: string;
  url: string;
  hasKey: boolean;
}

export interface ConnectorList {
  activeId: string | null;
  connectors: Connector[];
}

export interface ConnectorInput {
  name: string;
  url: string;
  // Blank keeps the saved key when editing.
  apiKey?: string;
  clearKey?: boolean;
}

export type TestResult = { ok: true; models: number } | { ok: false; error: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${method} ${path}: ${res.status} ${res.statusText}`);
  return data;
}

export const getConnectors = () => call<ConnectorList>("GET", "/api/connectors");
export const createConnector = (input: ConnectorInput) => call<Connector>("POST", "/api/connectors", input);
export const updateConnector = (id: string, input: ConnectorInput) => call<Connector>("PUT", `/api/connectors/${id}`, input);
export const deleteConnector = (id: string) => call<{ activeId: string | null }>("DELETE", `/api/connectors/${id}`);
export const setActiveConnector = (id: string) => call<{ activeId: string }>("PUT", "/api/active", { id });
export const testConnector = (input: { id?: string; url?: string; apiKey?: string; clearKey?: boolean }) =>
  call<TestResult>("POST", "/api/connectors/test", input);

export async function listModels(connectorId: string): Promise<Model[]> {
  const body = await call<{ data: any[] }>("GET", `/api/c/${connectorId}/v1/models`);
  return body.data.map((m) => ({
    id: m.id,
    status: m.status?.value ?? "unknown",
    inputs: m.architecture?.input_modalities ?? [],
    contextSize: contextSize(m),
  }));
}

// Per-model options, keyed by model id. Models nobody changed use defaults.
export interface ModelSettings {
  think: boolean;
}
export const getModelSettings = () =>
  call<{ defaults: ModelSettings; models: Record<string, ModelSettings> }>("GET", "/api/model-settings");
export const updateModelSettings = (model: string, changes: Partial<ModelSettings>) =>
  call<ModelSettings>("PATCH", "/api/model-settings", { model, ...changes });

// Chat display preferences, saved with the rest of the settings.
export interface Preferences {
  showContextMeter: boolean;
  showSteps: boolean;
}
export const getPreferences = () => call<Preferences>("GET", "/api/preferences");
export const updatePreferences = (changes: Partial<Preferences>) => call<Preferences>("PATCH", "/api/preferences", changes);

export const getDirectories = () => call<{ directories: string[] }>("GET", "/api/directories");
export const addDirectory = (path: string) => call<{ directories: string[] }>("POST", "/api/directories", { path });
export const removeDirectory = (path: string) => call<{ directories: string[] }>("DELETE", "/api/directories", { path });

export interface ToolInfo {
  name: string;
  label: string;
  summary: string;
  enabled: boolean;
}

export interface ToolGroup {
  id: string;
  label: string;
  description: string;
  // Why this group's tools can't be offered yet, or null when they can.
  unavailable: string | null;
  tools: ToolInfo[];
}

export interface ToolsState {
  groups: ToolGroup[];
  directories: string[];
  // Definitions of the tools that are on and ready, for sending to the model.
  definitions: unknown[];
  // Guidance for those tools, to send as the system message; null if none.
  systemPrompt: string | null;
}

// Tool definitions come from the server so they match what it can run.
export const getTools = () => call<ToolsState>("GET", "/api/tools");
export const setToolEnabled = (name: string, enabled: boolean) => call("PUT", `/api/tools/${name}`, { enabled });
export const runTool = (c: ToolCall) =>
  call<{ result: string }>("POST", "/api/tools/call", { name: c.name, arguments: c.arguments }).then((r) => r.result);

export interface Usage {
  // Everything now in the model's context: prompt, tools, history and reply.
  contextTokens: number;
  // Generation speed, when the server reports it.
  tokensPerSecond?: number;
  // Tokens the server read fresh this turn (not from its cache): roughly what
  // was added since the previous turn, e.g. tool results.
  promptTokens?: number;
}

// llama.cpp puts a timings block on the last chunk: cache_n tokens reused,
// prompt_n read this turn, predicted_n generated. OpenAI-style usage is the
// fallback for servers that send that instead.
function readUsage(chunk: any): Usage | undefined {
  const t = chunk.timings;
  if (t && typeof t.prompt_n === "number") {
    return {
      contextTokens: (t.cache_n ?? 0) + t.prompt_n + (t.predicted_n ?? 0),
      tokensPerSecond: t.predicted_per_second,
      promptTokens: t.prompt_n,
    };
  }
  const u = chunk.usage;
  if (u && typeof u.prompt_tokens === "number") {
    return { contextTokens: u.prompt_tokens + (u.completion_tokens ?? 0) };
  }
  return undefined;
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
}

export interface ChatRequest {
  connectorId: string;
  model: string;
  messages: ChatMessage[];
  // false asks the chat template to skip the reasoning phase, which small
  // Qwen models can otherwise drag out for minutes on trivial prompts.
  think: boolean;
  tools?: unknown[];
}

// Streams one chat completion, calling onDelta for each piece of text. Tool
// calls arrive as fragments spread over many chunks, so they're assembled
// here and returned once the stream ends.
export async function streamChat(
  { connectorId, model, messages, think, tools }: ChatRequest,
  onDelta: (d: StreamDelta) => void,
  signal: AbortSignal,
): Promise<{ toolCalls: ToolCall[]; usage?: Usage }> {
  const res = await fetch(`/api/c/${connectorId}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: messages.map(toWire),
      chat_template_kwargs: { enable_thinking: think },
      ...(tools?.length ? { tools } : {}),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /v1/chat/completions: ${res.status} ${text || res.statusText}`);
  }

  // Keyed by the fragment's index; the id and name come in the first one.
  const calls: ToolCall[] = [];
  // Tool results must reference an id, so make one up if the server sent none.
  let usage: Usage | undefined;
  const result = () => ({
    toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` })),
    usage,
  });

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return result();
    buffer += value;
    // SSE events can split across reads; keep the trailing partial line.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return result();
      const chunk = JSON.parse(data);
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
  }
}
