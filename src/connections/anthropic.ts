
import { messagesWire } from "./wires.ts";
import { signatureLabel } from "./anthropicSignature.ts";
import { EFFORTS, type Capabilities, type Connection, type Effort, InvalidOptions, type ModelOptions, isEffort, readErrorMessage } from "./types.ts";

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

// The beta behind thinking display "updates" (docs: build-with-claude/thinking,
// "Controlling thinking display"). What the API does when "updates" is asked
// for without this header, or on a model that doesn't write notes, is NOT
// checked (an error or a quiet fallback to "summarized"). Send one real request
// and read its upstream log line before relying on either.
export const THINKING_UPDATES_BETA = "thinking-display-updates-2026-08-18";

// WHY THERE IS A LIST, NOT A LOOKUP. Which models write a progress note before
// a tool call is named only in prose in the docs, section "Progress updates
// between tool calls": Fable 5, 5.1, 5.2, Mythos 5.1, 5.2, Opus 5.5, Sonnet 5.5.
//   https://platform.claude.com/docs/en/build-with-claude/thinking
// The Models API does not say:
//   https://platform.claude.com/docs/en/api/models/list
// Checked against the live GET /v1/models list for this account (thinking.types
// per model):
//
//   model                         thinking types           writes notes (docs)
//   claude-fable-5, -5-1, -5-2    adaptive                 yes
//   claude-opus-5-5               adaptive                 yes
//   claude-sonnet-5-5             adaptive, between_tools  yes
//   claude-opus-5, sonnet-5,
//     haiku-5-5, opus-4-7/4-8     adaptive, disabled       no
//   claude-sonnet-4-6, opus-4-6   enabled, adaptive, off   no
//   claude-opus-4-5, sonnet-4-5,
//     haiku-4-5                   enabled, disabled        no
//
// So "between_tools" is a different feature: only Sonnet 5.5 reports it, and
// reading it would drop Fable and Opus 5.5. The API lists no display modes
// ("summarized"/"updates") either, and its "line" field (fable, opus, …) is too
// wide a unit (Haiku and older Opus don't write notes) and the docs say not to
// infer a line from an id. Mythos wasn't on the account, so its id spelling is
// a guess from the docs' naming. If the API ever adds a capability for this,
// read that and delete the list.
//
// A dated id (…-20260101) counts too. Add a model here when the docs name it.
// Under "summarized" notes can't be told from reasoning; under "updates"
// reasoning is empty and any thinking text is a note.
const PROGRESS_UPDATE_MODEL = /^claude-(fable-5(-[12])?|mythos-5-[12]|opus-5-5|sonnet-5-5)(-\d{8})?$/;
// Thinking display "updates" is asked for only when the message says so (the
// Experimental switch, see withExperiments), the model writes notes and thinks
// adaptively; otherwise the display stays "summarized" and no beta is sent.
const asksForUpdates = (options: ModelOptions | undefined, caps: Capabilities | undefined): boolean =>
  options?.progressNotes === true && !!caps?.progressUpdates && !!caps.adaptiveThinking;
export const writesProgressUpdates = (id: unknown): boolean => typeof id === "string" && PROGRESS_UPDATE_MODEL.test(id);

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
  if (writesProgressUpdates(model?.id)) out.progressUpdates = true;
  if (model?.lifecycle === "deprecated" || model?.lifecycle === "retired") out.deprecated = true;
  set("retiresAt", typeof model?.retires_at === "string" ? model.retires_at : undefined);
  return out;
}

export const anthropic: Connection = {
  // Anthropic serves only Messages, whatever the API says.
  wire: () => messagesWire,
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
    const out: ModelOptions = {};
    if (o.progressNotes !== undefined && typeof o.progressNotes !== "boolean") throw new InvalidOptions("progressNotes must be true or false");
    // Kept only for a model that writes notes: for any other it does nothing.
    if (o.progressNotes === true && (!caps || caps.progressUpdates)) out.progressNotes = true;
    if (o.effort === undefined || o.effort === null) return out;
    if (!isEffort(o.effort)) throw new InvalidOptions(`effort must be one of ${EFFORTS.join(", ")}`);
    if (caps && !caps.efforts.includes(o.effort)) {
      throw new InvalidOptions(
        caps.efforts.length
          ? `This model doesn't take effort ${o.effort}. It takes: ${caps.efforts.join(", ")}.`
          : "This model has no effort setting.",
      );
    }
    return { ...out, effort: o.effort as Effort };
  },

  // The progress-notes experiment, for a model that writes notes.
  withExperiments: (options, experiments, caps) =>
    experiments?.progressNotes === true && caps?.progressUpdates ? { ...options, progressNotes: true } : options,

  fields(options, _purpose, caps, keepToolResults) {
    return {
      ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive", display: asksForUpdates(options, caps) ? "updates" : "summarized" } } : {}),
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

  // One anthropic-beta value, the betas comma-separated. "updates" is only
  // sent with adaptive thinking, the same condition as in fields().
  headers(caps, options): Record<string, string> {
    const betas = [
      ...(caps?.clearsToolResults ? [CONTEXT_EDITING_BETA] : []),
      ...(asksForUpdates(options, caps) ? [THINKING_UPDATES_BETA] : []),
    ];
    return betas.length ? { "anthropic-beta": betas.join(",") } : {};
  },
  // Anthropic clears them (context_management in fields).
  clearsToolResultsHere: false,
  // The SDK retries Anthropic's 429s and 529s; its default stands.
  maxRetries: undefined,
  errorMessage: readErrorMessage,

  // What a thinking block is. Asked for display "updates" (see fields): reasoning
  // blocks come back empty, so any text is a note for the user. Otherwise
  // ("summarized") both kinds are plain text, and the label in the signature
  // is the only hint (see anthropicSignature.ts): "narration" is a note,
  // "thinking" is reasoning. Anything else (no label, an unseen label, a
  // signature that doesn't read) is "unknown", so a changed format shows up in
  // the log instead of being guessed.
  classifyThinking(block, sent) {
    const asked = (sent.thinking as { display?: unknown } | undefined)?.display === "updates";
    if (asked) return block.hasText ? "progress" : "reasoning";
    const read = signatureLabel(block.signature);
    if (read === "unreadable") return "unknown";
    if (read.label === "narration") return "progress";
    if (read.label === "thinking") return "reasoning";
    return "unknown";
  },
};
