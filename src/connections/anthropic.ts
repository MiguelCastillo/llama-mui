import { EFFORTS, type Capabilities, type Connection, type Effort, InvalidOptions, isEffort } from "./types.ts";

// Anthropic's API. What a model takes comes from its own capabilities (the
// Models API: GET /v1/models/<id>), so a model only gets the settings it
// supports, and a request never carries a field it would refuse with a 400.
//
// Thinking: every request asks for adaptive thinking when the model supports
// it, whatever the purpose. Without it Claude tends to write its reasoning
// into the reply, and once that is quoted back in a chat Anthropic refuses
// later requests (reasoning_extraction). The summary shows in the Thoughts
// bar. Background calls (naming, a thread's report) keep thinking too: it is
// adaptive, so a short one-shot task barely uses it, and a name with
// reasoning in it would be worse than the few tokens. They get no effort,
// having no settings. A model without adaptive thinking (Haiku 4.5) gets no
// `thinking` field, and runs without thinking.
//
// Effort: output_config.effort, only when a level is set and the model
// supports that level.

// Reads capabilities from a model object of the Models API (a list entry or
// one model). Anything missing counts as not supported.
export function readCapabilities(model: any): Capabilities {
  const c = model?.capabilities ?? {};
  const effort = c.effort ?? {};
  return {
    adaptiveThinking: c.thinking?.types?.adaptive?.supported === true,
    efforts: effort.supported === true ? EFFORTS.filter((level) => effort[level]?.supported === true) : [],
  };
}

export const anthropic: Connection = {
  reasoningIsSummary: true,
  needsCapabilities: true,

  knobs(caps) {
    if (!caps?.efforts.length) return [];
    return [
      {
        key: "effort",
        label: "Effort",
        help: "How much effort Claude puts into thinking and answering. Default leaves it to the model.",
        levels: caps.efforts,
      },
    ];
  },

  validate(raw, caps) {
    const o: any = raw ?? {};
    // Think is llama.cpp's; it is dropped, not refused.
    if (o.effort === undefined || o.effort === null) return {};
    if (!isEffort(o.effort)) throw new InvalidOptions(`effort must be one of ${EFFORTS.join(", ")}`);
    if (caps && !caps.efforts.includes(o.effort)) {
      throw new InvalidOptions(
        caps.efforts.length
          ? `This model doesn't take effort ${o.effort}. It takes: ${caps.efforts.join(", ")}.`
          : "This model has no effort setting.",
      );
    }
    return { effort: o.effort as Effort };
  },

  fields(options, _purpose, caps) {
    return {
      ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      ...(options?.effort && caps?.efforts.includes(options.effort) ? { output_config: { effort: options.effort } } : {}),
      // Caches the conversation so far: each tool round resends it all, and
      // cached tokens cost a tenth.
      cache_control: { type: "ephemeral" },
    };
  },
};
