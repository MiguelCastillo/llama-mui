// Client for the dev server's /api routes: settings, attachments, the model's
// tools, and the model's API, proxied per connector at /api/c/<id>/v1: each
// connector speaks Anthropic's Messages (/v1/messages) or OpenAI's Chat
// Completions (/v1/chat/completions); llama.cpp serves both. The dev server
// adds each connector's key, so none of this code ever sees one.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { closeOpenToolCalls } from "./closeOpenToolCalls.ts";
export { closeOpenToolCalls } from "./closeOpenToolCalls.ts";
import { type Capabilities, type Effort, type ModelOptions, type Purpose, capabilitiesFromList, connection } from "./connections/index.ts";
export { EFFORTS, type Effort, isEffort, type ModelOptions, type Purpose, type Capabilities } from "./connections/index.ts";

export type ModelStatus = "loaded" | "loading" | "unloaded" | string;

export interface Model {
  id: string;
  // A name to show, when the server gives one (Anthropic's API does).
  name?: string;
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
  // What the model can do as far as the list says (Claude's list says all of
  // it; llama.cpp's only the images); see src/connections. getCapabilities has
  // the rest, once asked.
  capabilities?: Capabilities;
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
  // max_input_tokens is Anthropic's.
  return m.meta?.n_ctx ?? m.max_input_tokens ?? (fromArgs > 0 ? fromArgs : undefined);
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
  // On an assistant message: the id of the model that wrote it, for display.
  // Never sent to the model. Replies saved before this was recorded have none.
  model?: string;
  // Thinking tokens that Qwen-style models stream separately from the answer.
  reasoning?: string;
  // On a reply with signed thinking (Claude's): its content exactly as the
  // Messages API returned it, which is sent back instead of rebuilding the
  // turn. Claude only takes back thinking unchanged, block by block.
  blocks?: Anthropic.ContentBlockParam[];
  // Set on assistant messages that asked to run tools.
  toolCalls?: ToolCall[];
  // On an assistant message: what the model's note tools put under the reply
  // (an idea, something left for the user), shown in their own boxes. `kind` is
  // an id from NOTE_KINDS (replyNoteKinds.ts); `canDo` is set when the model
  // could do it itself with the user's approval (they get a button to say yes).
  // `done` is set when the user marked the action done; never sent to the model.
  // Never sent to the model as such; the call and its result are what the
  // history keeps.
  notes?: { kind: string; text: string; canDo?: boolean; done?: boolean }[];
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
  // On a user message sent while a plan ran: the step that saw it (counting
  // from 1), or notSeen if the plan ended before another step started. Shown
  // under the message; never sent to the model.
  seenByStep?: number;
  notSeen?: boolean;
  // On the messages of a side question: one asked while a plan ran, answered
  // apart from it (server/aside.ts). They are in the chat, but no plan step
  // sees them; a chat turn after the plan does.
  aside?: boolean;
  // On a user message: the response it replies to (its text). Shown in the
  // chat, so the history keeps what was answered; never sent to the model,
  // which only gets the message's own text.
  replyTo?: { text: string };
  // On a user message: references to images uploaded to this session. The
  // base64 data is read per request and passed to the model; never saved
  // into the session. Only meaningful on user messages.
  images?: ImageRef[];
}

// The most of a response that is kept as a message's `replyTo`: the chat only
// shows a few lines of it, and a very long response would bloat the session.
export const MAX_REPLY_QUOTE = 2000;

export interface StepStats {
  ms: number;
  // Approximate: thinking counts streamed pieces (about one token each); a
  // tool result gets its share of the tokens the next turn had to read.
  tokens?: number;
}

// Converts the chat to the Messages API's shape. The system prompt goes in
// `system`. An assistant turn is its thinking, text and tool calls, in the
// order the model wrote them; its tool results go in the user turn after it.
// The API wants turns to alternate, so a user message after tool results
// joins their turn. A reply that kept its blocks is sent back as they were;
// others without their thinking, which only Claude's signed blocks carry.
// `images` maps image ids to base64 data (read per request, never saved).
export function toMessages(
  history: ChatMessage[],
  images?: Record<string, string>,
): { system?: string; messages: Anthropic.MessageParam[] } {
  let system: string | undefined;
  const messages: Anthropic.MessageParam[] = [];
  const add = (role: "user" | "assistant", blocks: Anthropic.ContentBlockParam[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last?.role === role) (last.content as Anthropic.ContentBlockParam[]).push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of history) {
    if (m.role === "system") {
      system = system === undefined ? m.content : `${system}\n\n${m.content}`;
    } else if (m.role === "user") {
      const text = [m.content, m.update, m.note].filter(Boolean).join("\n\n");
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.images?.length && images) {
        for (const img of m.images) {
          const data = images[img.id];
          if (data) {
            blocks.push({
              type: "image",
              source: { type: "base64" as const, media_type: img.mediaType as "image/gif" | "image/jpeg" | "image/png" | "image/webp", data },
            });
          } else {
            blocks.push({
              type: "text",
              text: `[Image "${img.id}" missing — the file was deleted or not uploaded]`,
            });
          }
        }
      }
      if (text) {
        if (blocks.length) blocks.push({ type: "text", text });
        else blocks.push({ type: "text", text });
      }
      add("user", blocks);
    } else if (m.role === "tool") {
      add("user", [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }]);
    } else if (m.blocks?.length) {
      add("assistant", [...m.blocks]);
    } else {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parseInput(c.arguments) });
      add("assistant", blocks);
    }
  }
  return { system, messages };
}

// A tool call's arguments as the object tool_use wants. Text that isn't a
// JSON object (a model's broken call) goes as-is under `input`, so the call
// and its error result still pair up.
function parseInput(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : { input: args };
  } catch {
    return { input: args };
  }
}

// The tools' definitions are OpenAI-shaped (see fn in server/toolkit.ts).
function toTool(t: any): Anthropic.Tool {
  const f = t.function ?? t;
  return { name: f.name, description: f.description, input_schema: f.parameters ?? f.input_schema };
}

// What a connector is, and which API chat speaks to it (see Connector in
// server/store.ts).
export type Kind = "llama" | "anthropic";
export type Api = "anthropic" | "openai";

export interface Connector {
  id: string;
  name: string;
  url: string;
  hasKey: boolean;
  kind: Kind;
  api: Api;
  // The model chat starts with on this server, when one was chosen.
  defaultModel?: string;
}

export interface ConnectorList {
  connectors: Connector[];
}

export interface ConnectorInput {
  name: string;
  url: string;
  // Blank keeps the saved key when editing.
  apiKey?: string;
  clearKey?: boolean;
  // Set when it's added; it doesn't change.
  kind?: Kind;
  api?: Api;
  // Omitted keeps it; "" clears it.
  defaultModel?: string;
}

export type TestResult = { ok: true; models: number } | { ok: false; error: string };

// An answer that wasn't ok. `message` is the server's plain sentence; `status`
// and `data` (the rest of its JSON, e.g. a 409's `reason` and `revision`) are
// for the caller that has to tell one refusal from another.
export class ApiError extends Error {
  // Fields are written out, not constructor parameter properties, so Node can
  // run this file as it is (server/main.ts).
  status: number;
  data: Record<string, any>;
  constructor(message: string, status: number, data: Record<string, any> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Where the app's own /api is. In the browser it is the page's own origin, and a
// request just names its path. The server runs plans with this same code, in
// Node, where a path alone means nothing: the plugin calls setApiOrigin with its
// own address (http://127.0.0.1:<port>) once it is listening. Every request then
// goes through the server's own /api, whose proxy adds the connector's API key,
// so code running on the server never holds one.
let apiOrigin: string | null = null;

export function setApiOrigin(origin: string | null) {
  apiOrigin = origin ? origin.replace(/\/+$/, "") : null;
}

const originOf = () => apiOrigin ?? location.origin;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiOrigin ? apiOrigin + path : path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `${method} ${path}: ${res.status} ${res.statusText}`, res.status, data);
  return data;
}

export const getConnectors = () => call<ConnectorList>("GET", "/api/connectors");
export const createConnector = (input: ConnectorInput) => call<Connector>("POST", "/api/connectors", input);
export const updateConnector = (id: string, input: ConnectorInput) => call<Connector>("PUT", `/api/connectors/${id}`, input);
// Sets (or, with "", clears) a connector's default model. The update route
// wants the name and address, so it's sent the connector's own.
export const setDefaultModel = (c: Connector, defaultModel: string) =>
  updateConnector(c.id, { name: c.name, url: c.url, defaultModel });
export const deleteConnector = (id: string) => call<{ ok: true }>("DELETE", `/api/connectors/${id}`);
export const testConnector = (input: { id?: string; url?: string; apiKey?: string; clearKey?: boolean; kind?: Kind }) =>
  call<TestResult>("POST", "/api/connectors/test", input);

export async function listModels(connectorId: string): Promise<Model[]> {
  // Anthropic's API pages by 20 unless asked; llama.cpp ignores the limit.
  const body = await call<{ data: any[] }>("GET", `/api/c/${connectorId}/v1/models?limit=1000`);
  return readModels(connectorId, body.data);
}

// The model entries of a list (the OpenAI-style one, or the admin one), as
// Models with what each says it can do.
async function readModels(connectorId: string, data: any[]): Promise<Model[]> {
  const models = data.map((m) => {
    // The list says what each model can do (all of it for Claude, the images
    // for llama.cpp); keep it, so a request doesn't have to ask again.
    const capabilities = capabilitiesFromList(m);
    // Claude's list is the whole answer; llama.cpp's is the start of one.
    if (capabilities) (m.capabilities ? known : listed).set(`${connectorId}\n${m.id}`, capabilities);
    return {
      id: m.id,
      name: m.display_name,
      status: m.status?.value ?? "unknown",
      inputs: m.architecture?.input_modalities ?? [],
      contextSize: contextSize(m),
      canRemove: m.can_remove,
      source: m.source,
      sidecars: m.sidecars,
      size: m.size_in_bytes,
      ...(capabilities ? { capabilities } : {}),
    };
  });
  // A llama.cpp model that is loaded can say more (does its template think),
  // asked once and kept; the others can't answer without being loaded.
  await Promise.all(
    models.map(async (m, i) => {
      if (m.status !== "loaded" || m.capabilities?.thinking !== undefined || data[i].capabilities) return;
      const caps = await getCapabilities(connectorId, m.id);
      if (caps) m.capabilities = caps;
    }),
  );
  return models;
}

// What a model can do, by connector and model: the connection's own ask (the
// Models API for Claude, /props for llama.cpp, through the connector). A fact
// about the model, not a setting, so it is asked once and kept in memory; a
// failed ask isn't kept, and gives undefined (for llama.cpp, what the list said). A llama.cpp
// model that isn't loaded can't answer, so that is remembered for a few
// seconds only: asking again then doesn't hit the server on every request.
const known = new Map<string, Capabilities>();
const listed = new Map<string, Capabilities>();
const asking = new Map<string, Promise<Capabilities | undefined>>();
const missed = new Map<string, number>();
const MISS_MS = 15000;
export function getCapabilities(connectorId: string, model: string, kind?: Kind): Promise<Capabilities | undefined> {
  const key = `${connectorId}\n${model}`;
  const have = known.get(key);
  if (have) return Promise.resolve(have);
  const conn = connection(kind);
  const path = conn.capabilitiesPath(model);
  if (!path) return Promise.resolve(listed.get(key));
  if (Date.now() - (missed.get(key) ?? -Infinity) < MISS_MS) return Promise.resolve(listed.get(key));
  let pending = asking.get(key);
  if (!pending) {
    pending = call<unknown>("GET", `/api/c/${connectorId}${path}`)
      .then((answer) => {
        const caps = conn.fromAnswer(answer, listed.get(key));
        known.set(key, caps);
        return caps;
      })
      .catch(() => {
        missed.set(key, Date.now());
        return listed.get(key);
      })
      .finally(() => asking.delete(key));
    asking.set(key, pending);
  }
  return pending;
}
// For tests: forget what was learned.
export function forgetCapabilities() {
  known.clear();
  listed.clear();
  asking.clear();
  missed.clear();
}

// Model management endpoints (per-connector, at /api/c/<id>/models)
export function listModelsAdmin(connectorId: string): Promise<Model[]> {
  return call<{ data: any[] }>("GET", `/api/c/${connectorId}/models`).then((r) => readModels(connectorId, r.data));
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
export function searchModels(connectorId: string, query: string): Promise<SearchResult[]> {
  return call<SearchResult[]>("GET", `/api/c/${connectorId}/models/search?q=${encodeURIComponent(query)}`);
}

// Per-model options, keyed by model id. Models nobody changed use defaults.
// think is llama.cpp's; effort is Claude's, left out for the model's default.
// Each connection kind decides which a model has (src/connections).
export interface ModelSettings extends ModelOptions {
  think: boolean;
}
export const getModelSettings = () =>
  call<{ defaults: ModelSettings; models: Record<string, ModelSettings> }>("GET", "/api/model-settings");
// effort: null clears it, back to the model's default.
// connectorId says which connection the model is on, so the server checks the
// change against what that kind (and that model) takes.
export const updateModelSettings = (
  model: string,
  changes: Partial<Omit<ModelSettings, "effort">> & { effort?: Effort | null },
  connectorId?: string,
) => call<ModelSettings>("PATCH", "/api/model-settings", { model, ...(connectorId ? { connectorId } : {}), ...changes });

// Chat display preferences, saved with the rest of the settings.
export interface Preferences {
  showContextMeter: boolean;
  renderMarkdown: boolean;
  freshPlanSteps: boolean;
  showModelName: boolean;
}
export const getPreferences = () => call<Preferences>("GET", "/api/preferences");
export const updatePreferences = (changes: Partial<Preferences>) => call<Preferences>("PATCH", "/api/preferences", changes);

// An image that was uploaded to a session: a reference to a file on disk.
// The base64 data is never saved into the session; it is read per request and
// passed to the model API, then discarded.
export interface ImageRef {
  id: string;
  mediaType: string;
}

// A file or folder that can be attached to a chat, as the server resolved it.
export interface AttachmentTarget {
  path: string;
  kind: "file" | "folder";
}

// A folder or file the user chose to answer a prompt. `asWorkingDir`: the user
// ticked "Make it the working directory", so a folder is set as the chat's
// working directory instead of being attached.
export type Picked = AttachmentTarget & { asWorkingDir?: boolean };

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
// `enabled` is the master switch: off, none of them is offered.
export const getTools = () => call<{ enabled: boolean; groups: ToolGroup[] }>("GET", "/api/tools");
export const setToolsEnabled = (enabled: boolean) => call("PUT", "/api/tools", { enabled });
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
  // The working directory's check command, by folder; empty if it has none.
  checkCommands: Record<string, string>;
}

// What to offer the model in a chat with these attachments. Tool definitions
// come from the server so they match what it can run.
// A folder's check command (a typecheck, tests), saved for that folder in
// every session; an empty one clears it. Chat runs it after each plan step.
export const setCheckCommand = (folder: string, command: string) =>
  call<{ folder: string; command: string }>("PUT", "/api/tools/check-command", { folder, command });
// The last few working directories chosen (newest first; ones no longer on
// disk are left out), and remembering one just chosen.
export const getRecentFolders = () => call<{ folders: string[] }>("GET", "/api/tools/recent-folders");
export const rememberFolder = (folder: string) => call<{ folders: string[] }>("POST", "/api/tools/recent-folders", { folder });
// Only the working directory has one: `folder` must be `workingDir`.
export const runCheckCommand = (workingDir: string | null, attachments: string[], folder: string) =>
  call<{ command: string; passed: boolean; output: string }>("POST", "/api/tools/check-command", {
    workingDir,
    attachments,
    folder,
  });

// `workingDir`: the folder relative paths start in; `attachments`: the extra
// files and folders (not including it). `promptDir`: the working directory the
// session's system prompt names. `chatId`: the session the prompt is for; with
// it, the prompt says where that session shows in a browser (see sessionNote
// in server/tools.ts).
export const getToolContext = (workingDir: string | null, attachments: string[], promptDir: string | null, chatId?: string) =>
  call<ToolContext>("POST", "/api/tools/context", { workingDir, attachments, promptDir, ...(chatId ? { chatId } : {}) });
// The agent's own rules (~/.llama-mui/rules.md); Settings → Agent.
export interface Rules {
  text: string;
  // No file yet: this is the built-in default.
  isDefault: boolean;
}
export const getRules = () => call<Rules>("GET", "/api/rules");
export const saveRules = (text: string) => call<Rules>("PUT", "/api/rules", { text });
export const resetRules = () => call<Rules>("DELETE", "/api/rules");

// Using llama-mui from a phone (see server/phones.ts). Managing is for the
// computer running it; a phone only ever calls pairDevice.
export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
}
export interface PhoneInfo {
  // Whether the server listens beyond this computer (npm run dev:lan).
  reachable: boolean;
  port: number;
  addresses: { name: string; address: string }[];
  devices: PairedDevice[];
}
export const getPhone = () => call<PhoneInfo>("GET", "/api/phone");
export const createPairing = () => call<{ token: string; expiresAt: number }>("POST", "/api/phone/pairing");
export const removeDevice = (id: string) => call<{ id: string }>("DELETE", `/api/phone/devices/${id}`);
export const pairDevice = (token: string) => call<{ ok: true; name: string }>("POST", "/api/pair", { token });

// Something a tool wants to do that the user approves first: a change to a
// file, a shell command, or a git worktree being removed (making one needs no
// approval).
export type Approval =
  | {
      type: "change";
      path: string;
      action: "create" | "overwrite" | "edit";
      // Unified diff hunks.
      diff: string;
      // Why the model needs this, in its own words (may be missing).
      reason?: string;
    }
  // readOnly: the model's own claim that the command only looks (absent when it said nothing).
  | { type: "command"; command: string; cwd: string; reason?: string; readOnly?: boolean }
  | { type: "worktree"; action: "remove"; repo: string; branch: string; path: string; reason?: string }
  // inspect_page on a host other than this computer.
  | { type: "page"; url: string; host: string; reason?: string };

// Text for the model, a path outside the attachments that the user must allow
// before the call can run, or something the user must approve.
// needsLocation: the model asked (locate_path) for a file or folder the user
// named without a path; the user picks it.
export type ToolOutcome =
  | { result: string }
  | { needsAccess: AccessRequest }
  | { needsLocation: { description: string; kind: AttachmentTarget["kind"]; canSetWorkingDir?: boolean } }
  | { needsApproval: Approval };

export interface ToolCallContext {
  // The chat the call is for; the server tracks which files it has read.
  chatId: string;
  // The folder relative paths and commands start in; null is none.
  workingDir: string | null;
  // The extra files and folders; the working directory is not one of them.
  attachments: string[];
  // What the user allowed; the server goes ahead only if the call would
  // still do exactly that.
  approved?: Approval;
  // The session's open todos, for list_todos and complete_todo (the server
  // can't see the session; see server/todos.ts).
  todos?: { id: string; summary: string }[];
  // The connector and model the reply runs on, for a tool that has to ask a model
  // (summarize_thread; see server/threads.ts).
  connectorId?: string;
  model?: string;
}
export const runTool = (c: ToolCall, context: ToolCallContext) =>
  call<ToolOutcome>("POST", "/api/tools/call", { name: c.name, arguments: c.arguments, ...context });

// A saved chat: everything needed to reopen it where it was left.
// What the user chose to approve for the rest of a session without being asked
// again (see server/autoApprove.ts). Missing or empty: everything asks.
export interface AutoApprove {
  // Every file change.
  changes?: boolean;
  // Every command.
  commands?: boolean;
}

export type AutoKind = keyof AutoApprove;

export interface Session {
  id: string;
  title: string;
  model: string;
  // The connection this chat talks to (a Connector's id). Chats saved before
  // connections were chosen per chat don't have it; chat then uses the
  // last-used connection. A saved id may name a connection since deleted.
  connectorId?: string;
  messages: ChatMessage[];
  contextStart: number;
  // The extra files and folders the model may read. The working directory is
  // not one of them: it is `workingDir`.
  attachments: Attachment[];
  // The folder relative paths and commands start in: part of the chat's
  // environment, not an attachment. null is none. A chat saved before this
  // field has it undefined; the server converts it when it reads the chat
  // (see convertWorkingDir in server/sessionFile.ts).
  workingDir?: string | null;
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
  // One short sentence the model wrote about what the plan does, shown at the
  // top of the plan card; archived with the plan. Older saved chats don't have it.
  planSummary?: string | null;
  // Where `plan` shows: the id of the update_plan call that wrote it, or
  // "at:N", after the chat's first N messages: a clone, a plan from a chat
  // saved before this field, or one whose turn was compacted away ("at:0").
  planAnchor?: string | null;
  // Names the plan, so a thread note in another session can point at it (see
  // PlanThread). Set when the plan moves into a thread; a plan written in a
  // chat has none. Archived with the plan (PastPlan), and gone from here then.
  planId?: string | null;
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
  // The group the sessions panel lists this session under (top-level sessions;
  // a nested one follows its parent). Set by the user; the server owns it, so a
  // save never changes it. Null or missing: not in a group.
  group?: string | null;
  // Things to come back to, from add_todo; see src/agent/todos.ts. Older saved chats don't have it.
  todos?: Todo[];
  // The session this one is nested under (its direct parent). The panel shows
  // one level only: see buildSessionTree in sessionTree.ts. Older saved chats don't have it.
  parentId?: string | null;
  // Plans this session moved into their own nested sessions, each shown as a
  // note where the plan was. Older saved chats don't have it.
  threads?: PlanThread[];
  // Approvals given for the rest of this session (see AutoApprove).
  autoApprove?: AutoApprove;
  // The title until the model names the session (e.g. a plan's summary for a
  // thread's first message). Older saved chats don't have it.
  titleHint?: string | null;
  // The plan came from the parent session and has not run yet: Run runs it
  // here instead of moving it again. Cleared when the run starts.
  planMovedIn?: boolean;
  // How many times the server has written this session. Only the server sets
  // it: it is read with the session, and saveSession sends back the one this
  // page loaded (see knownRevision). Older saved chats don't have it.
  revision?: number;
  // The server's record of a plan running in this session now. Read only: a
  // save never sends it. Missing when nothing runs.
  run?: { status: string; startedAt: number };
  // Messages sent while a reply was running, waiting to be sent in order (at
  // most MAX_QUEUE). The server owns them, like the names: a save never changes
  // them, and a nested session starts with none. Older saved chats don't have it.
  queue?: QueuedMessage[];
  // The queue is waiting for the user: the reply before it was stopped or failed,
  // or the server restarted. Nothing in it is sent until Send next or Clear queue.
  queuePaused?: boolean;
}

// The most messages one session's queue holds.
export const MAX_QUEUE = 10;

// A message waiting in a session's queue, with what it needs to be sent later
// the way it was typed: the connection, model and switches the page had then.
export interface QueuedMessage {
  id: string;
  text: string;
  options: {
    connectorId?: string;
    model: string;
    toolsOn: boolean;
    // The model's settings when it was typed (see src/connections).
    modelOptions: ModelOptions;
    planning?: boolean;
  };
  images?: ImageRef[];
  // The message this one answers, if it was sent as a reply to one.
  replyTo?: string;
  // When it was queued (ms since 1970).
  queuedAt: number;
}

// A plan that runs in its own nested session; see planThread.ts.
export interface PlanThread {
  // The nested session the plan runs in.
  sessionId: string;
  // The plan's summary at the time it moved (or its first step).
  summary: string;
  // Where the note shows: the plan's anchor in the parent (see planAnchor).
  anchor: string | null;
  // The plan the note is about, inside that session (its planId). Today a
  // thread holds one plan; this lets a thread hold several later, with each
  // note pointing at its own. Missing on notes made before it.
  planId?: string;
  // How the thread's last run ended, written by the server when the run ends
  // (see server/threadReport.ts). Missing until a run has ended, and on notes
  // made before it; then the note works it out from the thread's saved plan.
  status?: ThreadOutcome;
  // What the model that ran the plan said about it, one or two sentences, and
  // when. Missing until it has written one (or while the next run is going).
  report?: { text: string; at: number };
}

// How a thread's run ended: every step done, a step failed, or neither.
export type ThreadOutcome = "done" | "failed" | "unfinished";

export interface Todo {
  id: string;
  // One line the model wrote (under 80 characters).
  summary: string;
  // The detail, in the user's words; may be empty.
  description: string;
  // The model's notes from when it was added: what a new thread needs from
  // the conversation. May be empty.
  context: string;
  status: "open" | "done";
  createdAt: number;
}

export interface PastPlan {
  steps: PlanStep[];
  anchor: string | null;
  // Context the model wrote alongside this plan, kept when archived.
  context?: string | null;
  // The plan's one-sentence summary, kept when archived.
  summary?: string | null;
  // The plan's id (Session.planId), kept when archived, so a note can still find it.
  planId?: string;
}

// One step of a plan. The model writes the text and a summary; chat sets the
// status as it runs and checks each step.
export interface PlanStep {
  // Stays the same when the step is edited or rerun; its messages carry it.
  id: string;
  // The instruction for the model.
  text: string;
  // A short to-do line for the user (at most 80 characters). Plans from
  // before summaries don't have it; see stepLine in agent/plan.ts.
  summary?: string;
  // "disputed": the check said it isn't done, the model showed it is (see
  // Plan.tsx, weighDispute), and the user decides.
  // "waiting": the step is blocked and the model asked the user a question
  // (the note); the user's answer goes in `answer` and the step reruns.
  status: "pending" | "running" | "done" | "failed" | "disputed" | "waiting";
  // Why a check failed or the step stopped, shown under the step. While
  // waiting, it is the question.
  note?: string;
  // The user's answer to a waiting step's question, and the question it
  // answers. stepPrompt passes both on when the step reruns.
  answer?: string;
  asked?: string;
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
  group?: string | null;
  // The session's open todos, without descriptions; see openTodoList in server/sessions.ts.
  todos?: { id: string; summary: string }[];
  // The session this one is nested under (its direct parent, any session). The
  // panel shows one level only; see buildSessionTree in sessionTree.ts. Null,
  // missing, or a parent that no longer exists: top level.
  parentId?: string | null;
}

// The revision of each session as this page last read or wrote it (the server
// counts its writes, see server/runHub.ts). A save sends it back, and the
// server refuses the save if the session has changed since, say in another
// window, instead of overwriting that. It only moves with this page's own
// calls: events from the server never touch it, or a stale page would pass
// for a current one. A session this page hasn't read or saved has none, and
// its first save is accepted as it always was.
const knownRevision = new Map<string, number>();

// For tests.
export const forgetRevisions = () => knownRevision.clear();

// A saved chat as the server answers it, with `revision` (and `run`, while a
// plan is running in it, which the page doesn't save back).
export const getSession = (id: string) =>
  call<Session>("GET", `/api/sessions/${id}`).then((s) => {
    if (typeof s.revision === "number") knownRevision.set(id, s.revision);
    return s;
  });

// Saved sessions, newest first, and the calls to open, save and delete one.
export const listSessions = () => call<SessionSummary[]>("GET", "/api/sessions");

// Answers with the session's list row. A 409 (ApiError) means the save was
// refused: `data.reason` is "stale revision" (changed somewhere else) or
// "run active" (a plan is running in it, so the run saves it).
export const saveSession = (s: Session) => {
  const revision = knownRevision.get(s.id);
  return call<SessionSummary & { revision: number }>("PUT", `/api/sessions/${s.id}`, {
    ...s,
    ...(revision === undefined ? {} : { revision }),
  }).then((row) => {
    knownRevision.set(s.id, row.revision);
    return row;
  });
};
// Where the session's work lives: one row per worktree in its folder, from git.
export interface WorktreeStatus {
  name: string;
  branch: string | null;
  uncommitted: number;
  unmerged: number | null;
  base: string | null;
}
export const getWorktreeStatuses = (id: string) => call<WorktreeStatus[]>("GET", `/api/sessions/${id}/worktrees`);
// A command to a session's run (see server/commands.ts): run, pause, resume,
// stop, approve, answer. Answers { ok, revision }; a command that can't be done
// is an ApiError, a 409 with a plain message and `data.reason`. `run` also says
// which session the plan runs in (`sessionId`): the session itself, or the new
// thread it moved to. `revision` is that session's.
export const sendCommand = (id: string, name: string, body: Record<string, unknown> = {}) =>
  call<{ ok: true; revision: number; sessionId?: string; step?: number; stepId?: string; messageId?: string; queued?: boolean }>("POST", `/api/sessions/${id}/commands/${name}`, body);

// The server wrote this session once (not a save from this page): `revision` is
// the new count. If it is the next one after what this page knew, nothing else
// wrote in between, so the page is still current and its next save may carry
// the new number; otherwise it is left as it was, and that save is refused.
export function noteRevision(id: string, revision: number) {
  if (knownRevision.get(id) === revision - 1) knownRevision.set(id, revision);
}

// Deletes the session and every session nested under it; `deleted` lists them
// all, the session last.
export const deleteSession = (id: string) =>
  call<{ id: string; deleted?: string[] }>("DELETE", `/api/sessions/${id}`).then((r) => {
    for (const gone of [id, ...(r.deleted ?? [])]) knownRevision.delete(gone);
    return r;
  });

// Delete a single uploaded image from a session's image store.
export const deleteImage = (sessionId: string, imageId: string) =>
  call<void>("DELETE", `/api/sessions/${sessionId}/images/${imageId}`);

export interface RenameSessionParams {
  title?: string;
  modelName?: string | null;
  userName?: string | null;
  group?: string | null;
}
export const renameSession = (id: string, params: RenameSessionParams) =>
  call<SessionSummary & { revision: number }>("PATCH", `/api/sessions/${id}`, params).then((row) => {
    // A rename is one server write. If it is the next one after what this page
    // knew, nothing else wrote in between, and the page is still current.
    if (knownRevision.get(id) === row.revision - 1) knownRevision.set(id, row.revision);
    return row;
  });

export interface Usage {
  // Everything now in the model's context: prompt, tools, history and reply.
  contextTokens: number;
  // Generation speed, when the server reports it.
  tokensPerSecond?: number;
  // Tokens the server read fresh this turn (not from its cache): roughly what
  // was added since the previous turn, e.g. tool results.
  promptTokens?: number;
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
}

export interface ChatRequest {
  connectorId: string;
  model: string;
  messages: ChatMessage[];
  // The model's settings the message carries, and why this request is made:
  // the connection kind's module turns them into request fields (see
  // src/connections). A background call has no settings.
  options?: ModelOptions;
  purpose: Purpose;
  tools?: unknown[];
  // The connector's kind and API; "llama" and "anthropic" when left out.
  kind?: Kind;
  api?: Api;
  // Image id → base64 data. Read per request from the server; never saved
  // into the session. Only meaningful on user messages.
  images?: Record<string, string>;
}

export interface ChatReply {
  // Whole, with arguments as the JSON text the model wrote.
  toolCalls: ToolCall[];
  usage?: Usage;
  // The reply's content as returned, when it has signed thinking, for the
  // message to keep (see ChatMessage). Only Claude signs its thinking.
  blocks?: Anthropic.ContentBlockParam[];
}

// Streams one reply, calling onDelta for each piece of text or thinking, in
// the connector's API. A tool call without a result would make the server
// reject the request, so those are closed first.
export async function streamChat(req: ChatRequest, onDelta: (d: StreamDelta) => void, signal: AbortSignal): Promise<ChatReply> {
  let repaired = { ...req, messages: closeOpenToolCalls(req.messages) };
  // A model that says it can't read images is never sent one, whatever the
  // chat holds (it was picked after the image went in, or is a plan's model).
  if (req.messages.some((m) => m.images?.length) && (await getCapabilities(req.connectorId, req.model, req.kind))?.images === false) {
    repaired = { ...repaired, messages: withoutImages(repaired.messages), images: undefined };
  }
  return repaired.api === "openai" ? streamCompletions(repaired, onDelta, signal) : streamMessages(repaired, onDelta, signal);
}

// The chat with each message's images taken out and a line saying so put in
// their place, for a model that can't read them. The saved chat keeps them.
export function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const n = m.images?.length ?? 0;
    if (!n) return m;
    const note = `[${n === 1 ? "An image was" : `${n} images were`} attached here but not sent: this model can't read images.]`;
    const { images: _dropped, ...rest } = m;
    return { ...rest, content: [m.content, note].filter(Boolean).join("\n\n") };
  });
}

// The Messages API requires a cap. Big enough for a step that writes a whole
// file; llama.cpp stops sooner when the context fills.
const MAX_TOKENS = 32768;

// The message inside an API error. llama.cpp's errors are {error: {message}},
// Anthropic's {type, error: {message}}.
function apiErrorMessage(e: InstanceType<typeof Anthropic.APIError>): string {
  const body = e.error as any;
  return body?.error?.message ?? body?.message ?? e.message;
}

// What a request carries beyond the chat: the connection kind's module
// decides, from the settings, the purpose and (for Claude) what the model can
// do. Without capabilities (the ask failed) a Claude request carries nothing
// optional, so it can't be refused for a setting the model lacks.
async function requestFields(connectorId: string, kind: Kind | undefined, model: string, options: ModelOptions | undefined, purpose: Purpose) {
  const conn = connection(kind);
  const caps = conn.needsCapabilities ? await getCapabilities(connectorId, model, kind) : undefined;
  return conn.fields(options, purpose, caps);
}

// The SDK's key is a placeholder: the dev server's proxy replaces it with the
// connector's, which is why it's safe in a browser.
async function streamMessages(
  { connectorId, kind, model, messages, options, purpose, tools, images }: ChatRequest,
  onDelta: (d: StreamDelta) => void,
  signal: AbortSignal,
): Promise<ChatReply> {
  const client = new Anthropic({
    baseURL: `${originOf()}/api/c/${connectorId}`,
    apiKey: "set-by-the-server",
    dangerouslyAllowBrowser: true,
    // The SDK retries only failed requests (Anthropic's 429s and 529s), never
    // a stream under way. llama.cpp has nothing worth retrying.
    ...(kind === "anthropic" ? {} : { maxRetries: 0 }),
  });
  const { system, messages: wire } = toMessages(messages, images);
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    messages: wire,
    ...(system ? { system } : {}),
    ...(tools?.length ? { tools: tools.map(toTool) } : {}),
    ...(await requestFields(connectorId, kind, model, options, purpose)),
  };

  const calls = new Map<number, ToolCall>();
  let final: Anthropic.Message | undefined;
  let input = 0;
  let cached = 0;
  let output = 0;
  try {
    final = await readStream(params);
  } catch (e) {
    // fetch's own TypeError, which failureLine reads as "couldn't reach".
    if (e instanceof Anthropic.APIConnectionError && e.cause instanceof TypeError) throw e.cause;
    if (e instanceof Anthropic.APIError && e.status) {
      throw new Error(`POST /v1/messages: ${e.status} ${apiErrorMessage(e)}`);
    }
    throw e;
  }

  async function readStream(body: object): Promise<Anthropic.Message> {
    const stream = client.messages.stream(body as Anthropic.MessageStreamParams, { signal });
    for await (const event of stream) {
      if (event.type === "message_start") {
        input = event.message.usage.input_tokens ?? 0;
        cached = (event.message.usage.cache_read_input_tokens ?? 0) + (event.message.usage.cache_creation_input_tokens ?? 0);
      } else if (event.type === "message_delta") {
        output = event.usage.output_tokens ?? output;
      } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: "" });
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d.type === "text_delta") onDelta({ content: d.text });
        else if (d.type === "thinking_delta") onDelta({ reasoning: d.thinking });
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
  // llama.cpp signs nothing (an empty signature), so only Claude's replies
  // need their blocks kept.
  const signed = final.content.some((b) => b.type === "redacted_thinking" || (b.type === "thinking" && b.signature));
  return {
    toolCalls: [...calls.values()].map((c, i) => ({ ...c, id: c.id || `call_${i}`, arguments: c.arguments || "{}" })),
    usage: input || cached || output ? { contextTokens: input + cached + output, promptTokens: input } : undefined,
    ...(signed ? { blocks: final.content as Anthropic.ContentBlockParam[] } : {}),
  };
}

// Converts to the OpenAI wire format, dropping UI-only fields like reasoning.
// `images` maps image ids to base64 data (read per request, never saved).
function toWire(m: ChatMessage, images?: Record<string, string>) {
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

// OpenAI's Chat Completions, through OpenAI's SDK (same placeholder key as
// streamMessages). Tool calls arrive as fragments spread over many chunks, so
// they're assembled here and returned once the stream ends. The SDK hands
// chunks over as parsed JSON, so llama.cpp's own fields (reasoning_content,
// timings) are there, just not in its types.
async function streamCompletions(
  { connectorId, kind, model, messages, options, purpose, tools, images }: ChatRequest,
  onDelta: (d: StreamDelta) => void,
  signal: AbortSignal,
): Promise<ChatReply> {
  const client = new OpenAI({
    baseURL: `${originOf()}/api/c/${connectorId}/v1`,
    apiKey: "set-by-the-server",
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });
  const params = {
    model,
    stream: true,
    messages: messages.map((m) => toWire(m, images)),
    ...(await requestFields(connectorId, kind, model, options, purpose)),
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
      const err = e.error as any;
      throw new Error(`POST /v1/chat/completions: ${e.status} ${err?.message ?? err?.error?.message ?? e.message}`);
    }
    throw e;
  }
  // Tool results must reference an id, so make one up if the server sent none.
  return { toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` })), usage };
}
