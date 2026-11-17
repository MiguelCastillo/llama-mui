import type { Kind } from "../api.ts";
import { anthropic } from "./anthropic.ts";
import { llama } from "./llama.ts";
import type { Capabilities, Connection, Experiments, ModelOptions } from "./types.ts";

export * from "./types.ts";
export { readCapabilities } from "./anthropic.ts";
export { readList, readProps } from "./llama.ts";

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
// `experiments` are the Experimental switches (Settings → Models); the
// connection adds the ones it knows, for this model, and ignores the rest.
export function optionsFor(kind: Kind | undefined, settings: ModelOptions | undefined, caps?: Capabilities, experiments?: Partial<Experiments>): ModelOptions {
  const out: ModelOptions = {};
  for (const knob of connection(kind).knobs(caps)) {
    if (knob.key === "think") out.think = settings?.think === true;
    else if (settings?.effort && knob.levels.includes(settings.effort)) out.effort = settings.effort;
  }
  return connection(kind).withExperiments(out, experiments, caps);
}

// What a model list entry says about the model, whichever kind sent it: Claude's
// entries carry `capabilities`, llama.cpp's an architecture.
export const capabilitiesFromList = (entry: any): Capabilities | undefined => anthropic.fromList(entry) ?? llama.fromList(entry);
