import type { Kind } from "../api.ts";
import { anthropic } from "./anthropic.ts";
import { llama } from "./llama.ts";
import type { Capabilities, Connection, ModelOptions } from "./types.ts";

export * from "./types.ts";
export { readCapabilities } from "./anthropic.ts";

// The module for a connection kind; "llama" when left out, as everywhere.
export const connection = (kind: Kind | undefined): Connection => (kind === "anthropic" ? anthropic : llama);

// A settings object checked for shape only, when the connection isn't known:
// both kinds' settings are kept.
export function validateShape(raw: unknown): ModelOptions {
  return { ...llama.validate(raw), ...anthropic.validate(raw) };
}

// The settings a message carries for a model: its saved settings, cut down to
// the knobs the model has now (a level saved for a model that takes no effort,
// or an older one, is left out, not sent).
export function optionsFor(kind: Kind | undefined, settings: ModelOptions | undefined, caps?: Capabilities): ModelOptions {
  const out: ModelOptions = {};
  for (const knob of connection(kind).knobs(caps)) {
    if (knob.key === "think") out.think = settings?.think === true;
    else if (settings?.effort && knob.levels.includes(settings.effort)) out.effort = settings.effort;
  }
  return out;
}
