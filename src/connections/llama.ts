import { type Connection, InvalidOptions, type ModelOptions, type Purpose } from "./types.ts";

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

export const llama: Connection = {
  reasoningIsSummary: false,
  needsCapabilities: false,

  knobs: () => [{ key: "think", label: "Think", help: "Think before answering. With it off, small models usually skip the tools." }],

  validate(raw) {
    const o: any = raw ?? {};
    if (o.think !== undefined && typeof o.think !== "boolean") throw new InvalidOptions("think must be true or false");
    // Claude's effort means nothing here; it is dropped, not refused.
    return o.think === undefined ? {} : { think: o.think };
  },

  // Not in the SDK's types, but both SDKs send the field.
  fields: (options, purpose) => ({ chat_template_kwargs: { enable_thinking: thinks(options, purpose) } }),
};
