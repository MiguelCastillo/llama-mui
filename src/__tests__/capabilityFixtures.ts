// What Anthropic's Models API says (GET /v1/models/<id>) for three models,
// as it really answered, cut to the parts the app reads.
const levels = (on: boolean) => ({ supported: on, low: { supported: on }, medium: { supported: on }, high: { supported: on }, xhigh: { supported: on }, max: { supported: on } });
const thinking = (types: Record<string, boolean>) => ({
  supported: true,
  types: Object.fromEntries(Object.entries(types).map(([k, v]) => [k, { supported: v }])),
});

const yes = { supported: true };
const no = { supported: false };

export const MODELS: Record<string, object> = {
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    max_input_tokens: 200000,
    max_tokens: 64000,
    lifecycle: "deprecated",
    retires_at: "2027-02-01T00:00:00Z",
    capabilities: { image_input: yes, pdf_input: yes, effort: levels(false), thinking: thinking({ enabled: true, adaptive: false, disabled: true, between_tools: false }) },
  },
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    lifecycle: "active",
    capabilities: { image_input: yes, pdf_input: yes, effort: levels(true), thinking: thinking({ enabled: false, adaptive: true, disabled: true, between_tools: true }) },
  },
  "claude-opus-5-5": {
    id: "claude-opus-5-5",
    capabilities: { image_input: no, pdf_input: no, effort: levels(true), thinking: thinking({ adaptive: true, disabled: false, between_tools: false }) },
  },
};

// A fetch answer for a Models API ask (GET /api/c/<id>/v1/models/<model>), or
// undefined when the url is something else.
export function modelAnswer(url: string, method = "GET"): Response | undefined {
  // llama.cpp's /props: a model that isn't loaded answers 400, as a router does.
  if (/\/props\?/.test(url) && method === "GET") return new Response(JSON.stringify({ error: { message: "model is not loaded" } }), { status: 400 });
  const m = /\/v1\/models\/([^/?]+)$/.exec(url);
  if (!m || method !== "GET") return undefined;
  const body = MODELS[decodeURIComponent(m[1])];
  return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ error: "unknown model" }), { status: 404 });
}

// What llama.cpp says (GET /props?model=<id>, loaded) for Miguel's Qwen3.6
// MTP model, cut down: the template is a stand-in with the same variables.
export const QWEN_PROPS = {
  modalities: { vision: true, video: true, audio: false },
  chat_template: "{%- if enable_thinking is defined and enable_thinking is false %}<think>\n\n</think>{%- endif %}",
  chat_template_caps: { supports_tools: true, supports_reasoning_effort: false, reasoning_effort_levels: [] },
};
// A model whose template never thinks: no switch to turn.
export const PLAIN_PROPS = { modalities: { vision: false }, chat_template: "{{ messages }}", chat_template_caps: { reasoning_effort_levels: [] } };
export const LIST_ENTRY = { id: "q", architecture: { input_modalities: ["text", "image", "video"] }, status: { value: "loaded" } };
