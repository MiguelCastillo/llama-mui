
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
//
// Old tool results: Anthropic clears them on its side (context editing,
// clear_tool_uses, a beta), because Claude's thinking signatures are bound to
// the exact history and an edit by llama-mui would break them; Anthropic's
// own clearing doesn't. Only for a model that reports the strategy, and only
// when llama-mui has decided some results go (requestCount in toolResults.ts,
// which also decides when the cut may move without breaking the cache).
// `keep` is the rest. The trigger is far below any real prompt: measured, with
// a trigger near the prompt's size Anthropic stops clearing once the prompt
// is under it, so how many it clears drifts between requests; with a low one
// it clears exactly all but `keep`. No exclude_tools, so Anthropic counts
// exactly what toolResults.ts counts. No clear_at_least: when a request can't
// clear that much, nothing is cleared for it at all. See docs/guide.md, "Old
// tool results".

// The beta context editing belongs to (docs: build-with-claude/context-editing).
export const CONTEXT_EDITING_BETA = "context-management-2025-06-27";
const CLEAR_TRIGGER_TOKENS = 1024;

// A "supported" flag the API reports, or undefined when it doesn't say.
const flag = (x: any): boolean | undefined => (typeof x?.supported === "boolean" ? x.supported : undefined);
const count = (n: unknown): number | undefined => (typeof n === "number" && n > 0 ? n : undefined);

// Reads capabilities from a model object of the Models API (a list entry or
// one model). A thing the API leaves out counts as not supported for
// adaptive thinking and effort (so a request never carries what the model
// might refuse); for images, PDFs and thinking it is unknown, so nothing is
// taken away on a guess.
export function readCapabilities(model: any): Capabilities {
  const c = model?.capabilities ?? {};
  const effort = c.effort ?? {};
  const out: Capabilities = {
    adaptiveThinking: c.thinking?.types?.adaptive?.supported === true,
    efforts: effort.supported === true ? EFFORTS.filter((level) => effort[level]?.supported === true) : [],
  };
  const set = <K extends keyof Capabilities>(key: K, value: Capabilities[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set("images", flag(c.image_input));
  set("pdf", flag(c.pdf_input));
  set("thinking", flag(c.thinking));
  set("contextSize", count(model?.max_input_tokens));
  set("maxOutput", count(model?.max_tokens));
  set("clearsToolResults", flag(c.context_management?.clear_tool_uses_20250919));
  if (model?.lifecycle === "deprecated" || model?.lifecycle === "retired") out.deprecated = true;
  set("retiresAt", typeof model?.retires_at === "string" ? model.retires_at : undefined);
  return out;
}

export const anthropic: Connection = {
  reasoningIsSummary: true,
  needsCapabilities: true,
  capabilitiesPath: (model) => `/v1/models/${encodeURIComponent(model)}`,
  // The list entries carry the same capabilities as one model's answer.
  fromList: (entry) => (entry?.capabilities ? readCapabilities(entry) : undefined),
  fromAnswer: (answer) => readCapabilities(answer),

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

  fields(options, _purpose, caps, keepToolResults) {
    return {
      ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      ...(options?.effort && caps?.efforts.includes(options.effort) ? { output_config: { effort: options.effort } } : {}),
      // Caches the conversation so far: each tool round resends it all, and
      // cached tokens cost a tenth.
      cache_control: { type: "ephemeral" },
      ...(caps?.clearsToolResults && keepToolResults !== undefined
        ? {
            context_management: {
              edits: [
                {
                  type: "clear_tool_uses_20250919",
                  trigger: { type: "input_tokens", value: CLEAR_TRIGGER_TOKENS },
                  keep: { type: "tool_uses", value: keepToolResults },
                },
              ],
            },
          }
        : {}),
    };
  },

  headers: (caps): Record<string, string> => (caps?.clearsToolResults ? { "anthropic-beta": CONTEXT_EDITING_BETA } : {}),
  // Anthropic clears them (context_management in fields).
  clearsToolResultsHere: false,
};
