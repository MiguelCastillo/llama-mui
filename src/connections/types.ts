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

export interface Connection {
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
  headers(caps?: Capabilities): Record<string, string>;
  // Whether the app leaves old tool results out of the request itself (see
  // clearOldToolResults in toolResults.ts). False where the server does it.
  clearsToolResultsHere: boolean;
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
