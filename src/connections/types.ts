// What a connection kind (llama.cpp, Anthropic) decides about a model: which
// settings it has, whether a settings object is valid, and which request
// fields the settings turn into. One module per kind (llama.ts, anthropic.ts)
// holds all of it; the rest of the app asks (see index.ts) and never checks
// the kind itself. No React, no I/O: pure, so the page and the server share it.

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
}

// What a model can do, as its connection says (a fact about the model, not a
// setting). Only Claude's is fetched (see getCapabilities in api.ts).
export interface Capabilities {
  // Adaptive thinking is supported (Haiku 4.5 and Sonnet 4.5 can't).
  adaptiveThinking: boolean;
  // The effort levels it takes; none when it takes no effort at all.
  efforts: Effort[];
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

export interface Connection {
  // What the `reasoning` this connection streams is. True: a short summary
  // written to be read (Claude's), so the chat shows it open in the steps and
  // its last line on the live line. False: the model's raw thoughts (Qwen's),
  // which are long, so they stay in a closed Thoughts row.
  reasoningIsSummary: boolean;
  // Whether knobs, validate and fields need the model's capabilities.
  needsCapabilities: boolean;
  // The settings this model has, with their allowed values.
  knobs(caps?: Capabilities): Knob[];
  // Checks a settings object (any shape) and returns it clean, with only the
  // settings this kind has. Throws InvalidOptions. Without capabilities the
  // values are checked for shape only.
  validate(raw: unknown, caps?: Capabilities): ModelOptions;
  // The request fields for these settings and this purpose. Settings may be
  // missing (a background call has none).
  fields(options: ModelOptions | undefined, purpose: Purpose, caps?: Capabilities): Record<string, unknown>;
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
  };
}
