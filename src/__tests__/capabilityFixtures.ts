// What Anthropic's Models API says (GET /v1/models/<id>) for three models,
// as it really answered, cut to the parts the app reads.
const levels = (on: boolean) => ({ supported: on, low: { supported: on }, medium: { supported: on }, high: { supported: on }, xhigh: { supported: on }, max: { supported: on } });
const thinking = (types: Record<string, boolean>) => ({
  supported: true,
  types: Object.fromEntries(Object.entries(types).map(([k, v]) => [k, { supported: v }])),
});

export const MODELS: Record<string, object> = {
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    capabilities: { effort: levels(false), thinking: thinking({ enabled: true, adaptive: false, disabled: true, between_tools: false }) },
  },
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5",
    capabilities: { effort: levels(true), thinking: thinking({ enabled: false, adaptive: true, disabled: true, between_tools: true }) },
  },
  "claude-opus-5-5": {
    id: "claude-opus-5-5",
    capabilities: { effort: levels(true), thinking: thinking({ adaptive: true, disabled: false, between_tools: false }) },
  },
};

// A fetch answer for a Models API ask (GET /api/c/<id>/v1/models/<model>), or
// undefined when the url is something else.
export function modelAnswer(url: string, method = "GET"): Response | undefined {
  const m = /\/v1\/models\/([^/?]+)$/.exec(url);
  if (!m || method !== "GET") return undefined;
  const body = MODELS[decodeURIComponent(m[1])];
  return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ error: "unknown model" }), { status: 404 });
}
