import { type Capabilities, type Connection, InvalidOptions, type ModelOptions, type Purpose } from "./types.ts";

// llama.cpp. Think asks the chat template for a reasoning phase before the
// answer (llama.cpp ignores `thinking: {type: "disabled"}`; its template takes
// chat_template_kwargs instead). Small Qwen models can think for minutes on a
// trivial prompt, so it's a switch, and only the first request of a reply
// uses it: not the tool rounds after it, not a planning reply, not a
// background call. The step check thinks on its first round only.
export function thinks(options: ModelOptions | undefined, purpose: Purpose): boolean {
  if (options?.think !== true) return false;
  if (purpose.kind === "background" || purpose.kind === "planning") return false;
  return purpose.round === 0;
}

// llama.cpp reports what a model takes in two places. The model list
// (GET /v1/models) has architecture.input_modalities for every model, loaded
// or not. GET /props?model=<id>, which only a loaded model answers (a router
// would load the model otherwise, so the page adds autoload=false), has
// modalities and the chat template. The server has no flag for "thinks", so it
// is read from the template: a template with enable_thinking has the switch
// Think turns (a template that thinks always has none to turn). reasoning_effort_levels is
// the template's own list (Qwen's is empty). A server that says nothing
// leaves the fact unknown.
export function readList(entry: any): Capabilities | undefined {
  const modalities = entry?.architecture?.input_modalities;
  if (!Array.isArray(modalities) || !modalities.length) return undefined;
  return { adaptiveThinking: false, efforts: [], images: modalities.includes("image") };
}

export function readProps(props: any, fromList?: Capabilities): Capabilities {
  const out: Capabilities = { adaptiveThinking: false, efforts: [], ...fromList };
  if (typeof props?.modalities?.vision === "boolean") out.images = props.modalities.vision;
  if (typeof props?.chat_template === "string" && props.chat_template) out.thinking = props.chat_template.includes("enable_thinking");
  const levels = props?.chat_template_caps?.reasoning_effort_levels;
  if (Array.isArray(levels)) out.reasoningEffortLevels = levels.filter((l: unknown) => typeof l === "string");
  return out;
}

export const llama: Connection = {
  reasoningIsSummary: false,
  needsCapabilities: true,
  capabilitiesPath: (model) => `/props?model=${encodeURIComponent(model)}&autoload=false`,
  fromList: readList,
  fromAnswer: readProps,

  // Think is offered unless the model's template is known to have no thinking switch.
  knobs: (caps) =>
    caps?.thinking === false
      ? []
      : [{ key: "think", label: "Think", help: "Think before answering. With it off, small models usually skip the tools." }],

  validate(raw) {
    const o: any = raw ?? {};
    if (o.think !== undefined && typeof o.think !== "boolean") throw new InvalidOptions("think must be true or false");
    // Claude's effort means nothing here; it is dropped, not refused.
    return o.think === undefined ? {} : { think: o.think };
  },

  // Not in the SDK's types, but both SDKs send the field.
  fields: (options, purpose) => ({ chat_template_kwargs: { enable_thinking: thinks(options, purpose) } }),
};
