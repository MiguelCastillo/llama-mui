// What a connection kind (llama.cpp, Anthropic) decides about a model: which
// settings it has, whether a settings object is valid, and which request
// fields the settings turn into. One module per kind (llama.ts, anthropic.ts)
// holds all of it; the rest of the app asks (see index.ts) and never checks
// the kind itself. No React, no I/O: pure, so the page and the server share it.

import type { Api, ChatReply, ChatRequest, StreamDelta, Usage } from "../api.ts";
import type { Tap } from "./tap.ts";

// How much effort Claude puts into a reply (the API's output_config.effort).
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

// The settings a message carries for its model (Settings → Models). One
// object, so a new setting is added here and in a connection module, nowhere
// else. think is llama.cpp's; effort is Claude's. Left out, the model's own
// default applies.
export interface ModelOptions {
  think?: boolean;
  effort?: Effort;
  // Claude's: the "progress notes" experiment is on for this message (see
  // Experiments below and withExperiments). Not a saved per-model setting: the
  // page adds it to each message from the experiments, so a queued message
  // keeps the value it was sent with.
  progressNotes?: boolean;
}

// Switches for features still being tried (Settings → Models, "Experimental"),
// each off until the user turns it on. Saved on the server (server/store.ts).
// A connection turns the ones it knows into settings on a message
// (withExperiments); the others ignore them.
export interface Experiments {
  // Claude: ask for the notes it writes before a tool call, apart from its
  // reasoning (thinking display "updates").
  progressNotes: boolean;
  // Server only: each plan thread works in its own git worktree, on its own
  // branch, instead of the project folder. No connection reads it.
  planWorktrees: boolean;
}

// What a model can do, as its connection says (a fact about the model, not a
// setting). Fetched once per model and kept (see getCapabilities in api.ts).
// Each connection fills what its server reports. An optional fact left out is
// unknown, which is not the same as false: unknown means the server said
// nothing, so the app offers the thing as if it were allowed (images, Think);
// only an explicit false takes it away.
export interface Capabilities {
  // Claude's: adaptive thinking is supported (Haiku 4.5 and Sonnet 4.5 can't).
  adaptiveThinking: boolean;
  // Claude's: the effort levels it takes; none when it takes no effort at all.
  efforts: Effort[];
  // Common facts, filled where the connection knows them.
  images?: boolean; // reads images
  pdf?: boolean; // reads PDFs
  thinking?: boolean; // thinks (Claude: any thinking; llama.cpp: its template has a thinking switch)
  contextSize?: number; // tokens of context it can take
  // Claude's: the most it writes in one reply, and the end of its life.
  maxOutput?: number;
  deprecated?: boolean; // Anthropic has marked it deprecated
  retiresAt?: string; // when it stops answering, as the API gives it
  // Claude's: Anthropic can clear old tool results on its side (context
  // editing's clear_tool_uses), so the request asks it to (see toolResults.ts).
  clearsToolResults?: boolean;
  // Claude's: the model writes progress notes between tool calls, so thinking
  // display "updates" (a beta) shows them apart from reasoning.
  progressUpdates?: boolean;
  // llama.cpp's: the reasoning_effort values its template renders distinctly,
  // lowest first. Not used for anything yet; empty for Qwen.
  reasoningEffortLevels?: string[];
}

// Why a request is made. The same settings turn into different fields by it.
// `round` counts the requests of one reply (or one check), from 0.
export type Purpose =
  | { kind: "reply"; round: number } // a chat reply: round 0 is its first request, later ones follow tool calls
  | { kind: "planning"; round: number } // a reply that writes a plan
  | { kind: "planStep"; round: number } // a reply that does one plan step
  | { kind: "stepCheck"; round: number } // the check of a finished step
  | { kind: "aside"; round: number } // a side question while a plan runs
  | { kind: "background" }; // session naming, a thread's report: one-shot, no settings

// One setting a model row shows.
export type Knob =
  | { key: "think"; label: string; help: string }
  | { key: "effort"; label: string; help: string; levels: Effort[] };

// Settings that don't suit the model (the message says what to change).
export class InvalidOptions extends Error {}

// What a wire reads out of a reply stream, whichever wire it is: the pieces
// the rest of the app understands. Later layers have wires produce these;
// for now they name the shared vocabulary.
export type StreamEvent =
  | { type: "text"; text: string } // words of the reply
  | { type: "thinking"; text: string } // reasoning words
  | { type: "call"; id: string; name: string; arguments: string } // a whole tool call, arguments as JSON text
  | { type: "usage"; usage: Usage }
  | { type: "error"; message: string } // the provider ended the stream with an error
  | { type: "stop"; reason?: string }; // the reply ended, with the provider's reason

// What a wire is handed besides the request.
export interface WireContext {
  // How many of the newest tool results go whole, for a server that clears the rest.
  keepToolResults?: number;
}

// One way of talking to a server: builds the request and reads the stream.
// Several connections can share a wire (llama.cpp serves both).
export interface Wire {
  name: Api;
  // The path a request to this wire goes to on the server.
  path: string;
  // A fresh reader of this wire's stream lines for the server's log (see tap.ts).
  tap(): Tap;
  // Streams one reply, calling onDelta for each piece of text or thinking.
  stream(req: ChatRequest, onDelta: (d: StreamDelta) => void, signal: AbortSignal, ctx?: WireContext): Promise<ChatReply>;
}

export interface Connection {
  // The wire this connection uses for an API ("anthropic" when the API is
  // left out, as everywhere). A connection that doesn't serve the API gets
  // the Messages wire, as before.
  wire(api?: Api): Wire;
  // What the `reasoning` this connection streams is. True: a short summary
  // written to be read (Claude's), so the chat shows it open in the steps and
  // its last line on the live line. False: the model's raw thoughts (Qwen's),
  // which are long, so they stay in a closed Thoughts row.
  reasoningIsSummary: boolean;
  // Whether knobs, validate and fields need the model's capabilities, so they
  // are asked for before a request (a failed ask leaves them unknown).
  needsCapabilities: boolean;
  // Where this connection asks for one model's capabilities, relative to the
  // connector's proxy (/api/c/<id>), or undefined when there is nowhere to ask.
  capabilitiesPath(model: string): string | undefined;
  // Whether the server's model list (read just now) holds this model id. A
  // chat's stored model that this says no to is shown in a notice and never
  // replaced. Every connection answers; shared code never compares ids itself.
  listsModel(listed: readonly { id: string }[], id: string): boolean;
  // What the model list says about a model, before anything is asked (a list
  // entry as the server sent it).
  fromList(entry: any): Capabilities | undefined;
  // What the answer at capabilitiesPath says, on top of what the list said.
  fromAnswer(answer: any, fromList?: Capabilities): Capabilities;
  // The settings this model has, with their allowed values.
  knobs(caps?: Capabilities): Knob[];
  // Checks a settings object (any shape) and returns it clean, with only the
  // settings this kind has. Throws InvalidOptions. Without capabilities the
  // values are checked for shape only.
  validate(raw: unknown, caps?: Capabilities): ModelOptions;
  // The request fields for these settings and this purpose. Settings may be
  // missing (a background call has none). `keepToolResults` is how many of the
  // newest tool results the request sends whole (all but requestCount in
  // toolResults.ts), for a server that clears the others itself; left out
  // while nothing is cleared.
  fields(options: ModelOptions | undefined, purpose: Purpose, caps?: Capabilities, keepToolResults?: number): Record<string, unknown>;
  // Headers the request needs for those fields (a beta a field belongs to).
  headers(caps?: Capabilities, options?: ModelOptions): Record<string, string>;
  // The message's settings with the experiments this connection knows added
  // to them, for this model. A connection with no experiment returns the
  // settings as they are. Shared code calls this and never reads an
  // experiment itself.
  withExperiments(options: ModelOptions, experiments: Partial<Experiments> | undefined, caps?: Capabilities): ModelOptions;
  // Whether the app leaves old tool results out of the request itself (see
  // clearOldToolResults in toolResults.ts). False where the server does it.
  clearsToolResultsHere: boolean;
  // How many times the SDK retries a failed request (never a stream under
  // way). Undefined leaves the SDK's own default.
  maxRetries: number | undefined;
  // The message inside a provider's error body (the body as the SDK parsed
  // it), or `fallback` when the body has none.
  errorMessage(body: unknown, fallback: string): string;
  // What one thinking block from this connection is: the model's reasoning, a
  // note it wrote for the user between tool calls, or "unknown" when this
  // connection can't tell (the caller logs that, and shows it as reasoning).
  // `sent` is the request fields this connection's own `fields` returned for
  // the request, so the connection can see what it asked for (Claude's
  // thinking display) without the caller knowing what that means. Every
  // connection answers; one with no notes always says "reasoning". Shared code
  // (wires, the log) asks this and never reads signatures or settings itself.
  classifyThinking(block: ThinkingBlock, sent: Record<string, unknown>): ThinkingKind;
}

// A thinking block as a wire (or the server's log) collected it: whether it
// has any words, and the signature when the connection sends one (Claude does;
// llama.cpp doesn't). Not the words themselves: telling what a block is never
// needs them, and the log must not keep them.
export interface ThinkingBlock {
  hasText: boolean;
  signature?: string;
}
export type ThinkingKind = "reasoning" | "progress" | "unknown";

// llama.cpp's errors are {error: {message}}, Anthropic's {type, error: {message}};
// the OpenAI SDK hands over the inner object, {message}. All three are read here.
export function readErrorMessage(body: unknown, fallback: string): string {
  const b = body as any;
  const found = b?.error?.message ?? b?.message;
  return typeof found === "string" && found ? found : fallback;
}

// Reads a settings object that may be older: before ModelOptions a message
// carried `thinkOn` and `effort` beside it. `modelOptions` wins when present.
// Never throws; anything unreadable is left out. Used for saved queues and
// for pages that haven't reloaded since.
export function readModelOptions(o: { modelOptions?: unknown; thinkOn?: unknown; effort?: unknown } | null | undefined): ModelOptions {
  const src: any = o?.modelOptions && typeof o.modelOptions === "object" ? o.modelOptions : { think: o?.thinkOn, effort: o?.effort };
  return {
    ...(typeof src.think === "boolean" ? { think: src.think } : {}),
    ...(isEffort(src.effort) ? { effort: src.effort } : {}),
    ...(typeof src.progressNotes === "boolean" ? { progressNotes: src.progressNotes } : {}),
  };
}
