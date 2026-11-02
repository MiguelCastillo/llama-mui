// Client for the dev server's /api routes: settings, attachments, the model's
// tools, and llama.cpp's OpenAI-compatible API proxied
// per connector at /api/c/<id>/v1. The dev server adds each connector's key,
// so none of this code ever sees one.

export type ModelStatus = "loaded" | "loading" | "unloaded" | string;

export interface Model {
  id: string;
  status: ModelStatus;
  inputs: string[];
  // Tokens the server gives this model's context, when it says.
  contextSize?: number;
  // Whether the server can delete it: true for downloaded models ("cache"),
  // false for ones defined in the server's preset file ("preset").
  canRemove?: boolean;
  // "cache" or "preset", as above.
  source?: string;
  // Extra files downloaded with it, e.g. ["mmproj"].
  sidecars?: string[];
  // File size in bytes
  size?: number;
}

export interface SearchResult {
  id: string;
  author: string;
  license: string | null;
  tags: string[];
  likes?: number;
  downloads?: number;
  // GGUF-specific fields
  model?: string;
  fileFormat?: string;
  quantizationLevel?: string;
  parameters?: string;
  // For download
  filename?: string;
  url?: string;
}

export interface SseEvent {
  event: string;
  data: string;
}

// The context the server runs a model with: meta.n_ctx once it's loaded,
// else the --ctx-size it will start with. Not context_length: that's what the
// model was trained for, and a model with no --ctx-size starts with 4096, not
// that (a 262,144 shown for Qwen3.6 ran with 4096 and refused a 16k prompt).
// Undefined when the server doesn't say, so nothing guesses from it.
function contextSize(m: any): number | undefined {
  const args: string[] = m.status?.args ?? [];
  const i = args.indexOf("--ctx-size");
  const fromArgs = i >= 0 ? Number(args[i + 1]) : NaN;
  return m.meta?.n_ctx ?? (fromArgs > 0 ? fromArgs : undefined);
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
  // Set on the result of a file change the user approved: the diff they saw,
  // with a few lines around each change. Never sent to the model.
  diff?: string;
  // Set on the messages of a plan step's turn: that step's id. They're sent to
  // the model like any other, but show under the step instead of in the chat.
  planStep?: string;
  // How long a step took and roughly how many tokens it used, for display.
  // On assistant messages it covers the thinking; on tool messages, the run.
  stats?: StepStats;
  // On the last message of a finished reply: how long the whole reply took,
  // from sending, and two speeds. `clientTps` is what reached the browser:
  // pieces streamed (about one token each) over the time they took to arrive,
  // across all rounds, leaving out waits for tools and first tokens.
  // `serverTps` is llama.cpp's own generation speed, for the last round. A big
  // gap means the server was slow to deliver, not the model to generate.
  took?: { ms: number; clientTps?: number; serverTps?: number };
  // Instructions sent to the model after this message's text, shown only on request:
  // the planning note on a message that gets a planning turn. It's saved with
  // the message, so every later request sends the same text and llama.cpp's
  // prompt cache keeps matching (see PLANNING_NOTE).
  note?: string;
  // On a user message: a chat update ("Chat update: …", see chatUpdate in
  // server/tools.ts), sent before `note` when it changed since the last one.
  // Saved for the same reason as `note`; shown only on request.
  update?: string;
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
  return { role: m.role, content: [m.content, m.update, m.note].filter(Boolean).join("\n\n") };
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
export const getActiveConnectorId = () => call<{ activeId: string | null }>("GET", "/api/connectors").then((r) => r.activeId);
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
    canRemove: m.can_remove,
    source: m.source,
    sidecars: m.sidecars,
    size: m.size_in_bytes,
  }));
}

// Model management endpoints (per-connector, at /api/c/<id>/models)
export function listModelsAdmin(connectorId: string): Promise<Model[]> {
  return call<{ data: any[] }>("GET", `/api/c/${connectorId}/models`).then((r) =>
    r.data.map((m) => ({
      id: m.id,
      status: m.status?.value ?? "unknown",
      inputs: m.architecture?.input_modalities ?? [],
      contextSize: contextSize(m),
      canRemove: m.can_remove,
      source: m.source,
      sidecars: m.sidecars,
      size: m.size_in_bytes,
    })),
  );
}

export function downloadModel(connectorId: string, model: string, sidecars?: string[]): Promise<void> {
  return call<void>("POST", `/api/c/${connectorId}/models`, { model, sidecars });
}

// SSE endpoint - returns a ReadableStream for streaming progress events
export function getDownloadProgressStream(connectorId: string): ReadableStream {
  const evtSource = new EventSource(`/api/c/${connectorId}/models/sse`);
  const textEncoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      evtSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.event === "download_progress") {
            controller.enqueue(textEncoder.encode(JSON.stringify({ progress: data.data.progress ?? "0%" })));
          }
        } catch {
          // Ignore parse errors
        }
      };
      evtSource.onerror = () => {
        controller.close();
        evtSource.close();
      };
      // End the stream when the server closes the connection
      evtSource.addEventListener("end", () => controller.close());
    },
  });
}

export function loadModel(connectorId: string, model: string): Promise<void> {
  return call<void>("POST", `/api/c/${connectorId}/models/load`, { model });
}

export function unloadModel(connectorId: string, model: string): Promise<void> {
  return call<void>("POST", `/api/c/${connectorId}/models/unload`, { model });
}

export function deleteModel(connectorId: string, model: string): Promise<void> {
  return call<void>("DELETE", `/api/c/${connectorId}/models?model=${encodeURIComponent(model)}`);
}

// Search Hugging Face for GGUF models (per-connector endpoint)
export function searchModels(query: string): Promise<SearchResult[]> {
  return getActiveConnectorId().then((activeId) => {
    if (!activeId) throw new Error("No active connector");
    return call<any[]>("GET", `/api/c/${activeId}/models/search?q=${encodeURIComponent(query)}`).then((r) => r);
  });
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
  renderMarkdown: boolean;
  freshPlanSteps: boolean;
}
export const getPreferences = () => call<Preferences>("GET", "/api/preferences");
export const updatePreferences = (changes: Partial<Preferences>) => call<Preferences>("PATCH", "/api/preferences", changes);

// A file or folder that can be attached to a chat, as the server resolved it.
export interface AttachmentTarget {
  path: string;
  kind: "file" | "folder";
}

// A path the model asked for outside the chat's attachments. kind is null
// when nothing exists there, so the user can point to the right one instead.
export interface AccessRequest {
  path: string;
  kind: AttachmentTarget["kind"] | null;
}

// A file or folder attached to one chat. Only the disk tools in that chat can
// read it; the server re-checks every path on each call.
export interface Attachment extends AttachmentTarget {
  // "manual": attached with the paperclip. "request": the model asked for it
  // and the user allowed it.
  source: "manual" | "request";
}

// Resolves a path the user typed (~ expanded, symlinks followed), or throws
// a message saying why it can't be attached.
export const checkAttachment = (path: string) =>
  call<AttachmentTarget>("POST", "/api/attachments/check", { path });

// Opens the system file or folder dialog on the machine running the server
// (macOS only); resolves with what was picked, or nothing if cancelled.
export const pickAttachments = (kind: AttachmentTarget["kind"]) =>
  call<{ attachments: AttachmentTarget[] }>("POST", "/api/attachments/pick", { kind }).then((r) => r.attachments);

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
  tools: ToolInfo[];
}

// For Settings → Tools: every group and each tool's on/off state.
export const getTools = () => call<{ groups: ToolGroup[] }>("GET", "/api/tools");
export const setToolEnabled = (name: string, enabled: boolean) => call("PUT", `/api/tools/${name}`, { enabled });

// The definitions and system prompt are the same in every chat; see
// toolsSystemPrompt in server/tools.ts.
export interface ToolContext {
  // Definitions of every tool, for the model, including ones that are off.
  definitions: unknown[];
  // Guidance for the tools, to send as the system message.
  systemPrompt: string | null;
  // The tools that are on.
  offered: string[];
  // What's attached and what's off, for a ChatMessage's `update`.
  update: string;
  // The check commands of attached folders, by folder.
  checkCommands: Record<string, string>;
}

// What to offer the model in a chat with these attachments. Tool definitions
// come from the server so they match what it can run.
// A folder's check command (a typecheck, tests), saved for that folder in
// every session; an empty one clears it. Chat runs it after each plan step.
export const setCheckCommand = (folder: string, command: string) =>
  call<{ folder: string; command: string }>("PUT", "/api/tools/check-command", { folder, command });
export const runCheckCommand = (attachments: string[], folder: string) =>
  call<{ command: string; passed: boolean; output: string }>("POST", "/api/tools/check-command", {
    attachments,
    folder,
  });

// `promptDir`: the working directory the session's system prompt names.
export const getToolContext = (attachments: string[], promptDir: string | null) =>
  call<ToolContext>("POST", "/api/tools/context", { attachments, promptDir });
// Something a tool wants to do that the user approves first: a change to a
// file, or a shell command.
export type Approval =
  | {
      type: "change";
      path: string;
      action: "create" | "overwrite" | "edit";
      // Unified diff hunks.
      diff: string;
    }
  | { type: "command"; command: string; cwd: string };

// Text for the model, a path outside the attachments that the user must allow
// before the call can run, or something the user must approve.
// needsLocation: the model asked (locate_path) for a file or folder the user
// named without a path; the user picks it.
export type ToolOutcome =
  | { result: string }
  | { needsAccess: AccessRequest }
  | { needsLocation: { description: string; kind: AttachmentTarget["kind"] } }
  | { needsApproval: Approval };

export interface ToolCallContext {
  // The chat the call is for; the server tracks which files it has read.
  chatId: string;
  attachments: string[];
  // What the user allowed; the server goes ahead only if the call would
  // still do exactly that.
  approved?: Approval;
}
export const runTool = (c: ToolCall, context: ToolCallContext) =>
  call<ToolOutcome>("POST", "/api/tools/call", { name: c.name, arguments: c.arguments, ...context });

// A saved chat: everything needed to reopen it where it was left.
export interface Session {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  contextStart: number;
  attachments: Attachment[];
  usage: Usage | null;
  // Failure of the last reply; see Chat.tsx. Older saved chats don't have it.
  failed: string | null;
  // The task's steps from update_plan; see Plan.tsx. Older saved chats don't have it.
  plan: PlanStep[] | null;
  // A change to the plan the model suggested outside planning and runs,
  // waiting for the user to accept it. Older saved chats don't have it.
  planProposal?: PlanStep[] | null;
  // Context the model wrote alongside the plan (e.g. requirements, notes),
  // kept when the plan is approved and moved into pastPlans when archived.
  planContext?: string | null;
  // Where `plan` shows: the id of the update_plan call that wrote it, or
  // "at:N", after the chat's first N messages: a clone, a plan from a chat
  // saved before this field, or one whose turn was compacted away ("at:0").
  planAnchor?: string | null;
  // Finished plans, each left where it was written when a new one came.
  pastPlans?: PastPlan[];
  // The working directory the system prompt names, fixed at the session's
  // first message so the system prompt never changes (see Chat.tsx). Missing
  // until then, and in older chats.
  promptDir?: string | null;
  // The name the model gave the session on its first reply (if any).
  // The user can override it with a rename. Displayed title is userName,
  // else modelName, else title (first message). Never overwritten by save.
  modelName?: string | null;
  userName?: string | null;
}

export interface PastPlan {
  steps: PlanStep[];
  anchor: string | null;
  // Context the model wrote alongside this plan, kept when archived.
  context?: string | null;
}

// One step of a plan. The model writes only the text; chat sets the status
// as it runs and checks each step.
export interface PlanStep {
  // Stays the same when the step is edited or rerun; its messages carry it.
  id: string;
  text: string;
  // "disputed": the check said it isn't done, the model showed it is (see
  // Plan.tsx, weighDispute), and the user decides.
  status: "pending" | "running" | "done" | "failed" | "disputed";
  // Why a check failed or the step stopped, shown under the step.
  note?: string;
  // An earlier step was rerun after this one was done, so it may be out of date.
  stale?: boolean;
  // How long the step took, from its "Do step" message until its check finished,
  // the retry included. Rerunning a step replaces its time.
  ms?: number;
}

// One row in the sessions panel.
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  modelName?: string | null;
  userName?: string | null;
}

// Saved chats, newest first, and the calls to open, save and delete one.
export const listSessions = () => call<SessionSummary[]>("GET", "/api/chats");
export const getSession = (id: string) => call<Session>("GET", `/api/chats/${id}`);
export const saveSession = (s: Session) => call<SessionSummary>("PUT", `/api/chats/${s.id}`, s);
export const deleteSession = (id: string) => call<{ id: string }>("DELETE", `/api/chats/${id}`);

export interface RenameSessionParams {
  title?: string;
  modelName?: string | null;
  userName?: string | null;
}
export const renameSession = (id: string, params: RenameSessionParams) =>
  call<SessionSummary>("PATCH", `/api/chats/${id}`, params);

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
