import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatMessage, forgetCapabilities, getCapabilities, listModels, listModelsAdmin, streamChat, withoutImages } from "../api";
import { LIST_ENTRY, MODELS, PLAIN_PROPS, QWEN_PROPS, modelAnswer } from "./capabilityFixtures";

// What each model server says about its models reaches the app: the list's
// context size and images, llama.cpp's /props (asked once per model, never
// loading it), and a request that never carries an image to a model that says
// it takes none.

const asked: string[] = [];
let chatBodies: any[] = [];
let props: Record<string, object | number> = {};
let list: object[] = [];

function serve() {
  asked.length = 0;
  chatBodies = [];
  vi.stubGlobal("location", { origin: "http://test" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      asked.push(u);
      if (/\/v1\/models\?/.test(u) || /\/c\/c1\/models$/.test(u)) return Response.json({ data: list });
      const p = /\/props\?model=([^&]+)&autoload=false$/.exec(u);
      if (p) {
        const got = props[decodeURIComponent(p[1])];
        return typeof got === "object" ? Response.json(got) : Response.json({ error: { message: "model is not loaded" } }, { status: (got as number) ?? 400 });
      }
      const m = modelAnswer(u, init?.method);
      if (m) return m;
      chatBodies.push(JSON.parse(String(init?.body ?? "{}")));
      if (u.endsWith("/v1/chat/completions")) {
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      const ev = [
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }),
  );
}

beforeEach(() => {
  forgetCapabilities();
  props = {};
  list = [];
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("listModels", () => {
  it("gives a Claude model's real context size, images and the rest from its list entry", async () => {
    list = [{ ...MODELS["claude-sonnet-5-5"], display_name: "Sonnet 5.5" }];
    const [m] = await listModels("c1");
    expect(m.contextSize).toBe(1000000);
    expect(m.capabilities).toMatchObject({ images: true, pdf: true, contextSize: 1000000, maxOutput: 128000 });
    // The list was the whole answer: no second ask.
    await getCapabilities("c1", "claude-sonnet-5-5", "anthropic");
    expect(asked.filter((u) => /models\/claude/.test(u))).toEqual([]);
  });

  it("takes a llama.cpp model's images from input_modalities, and asks /props only of a loaded one", async () => {
    props = { loaded: QWEN_PROPS };
    list = [
      { ...LIST_ENTRY, id: "loaded" },
      { ...LIST_ENTRY, id: "idle", status: { value: "unloaded" } },
    ];
    const [loaded, idle] = await listModels("c1");
    expect(asked.filter((u) => u.includes("/props?"))).toEqual(["/api/c/c1/props?model=loaded&autoload=false"]);
    expect(loaded.capabilities).toMatchObject({ images: true, thinking: true });
    expect(idle.capabilities).toEqual({ adaptiveThinking: false, efforts: [], images: true });
    expect(idle.capabilities?.thinking).toBeUndefined();
  });
});

describe("the Models page's list", () => {
  it("carries the same capabilities as the chat's, so its rows can show them", async () => {
    props = { loaded: QWEN_PROPS };
    list = [
      { ...LIST_ENTRY, id: "loaded" },
      { ...LIST_ENTRY, id: "idle", status: { value: "unloaded" } },
    ];
    const [loaded, idle] = await listModelsAdmin("c1");
    expect(loaded.capabilities).toMatchObject({ images: true, thinking: true });
    expect(idle.capabilities).toMatchObject({ images: true });
  });
});

describe("getCapabilities for llama.cpp", () => {
  it("asks once and keeps the answer", async () => {
    props = { q: PLAIN_PROPS };
    expect(await getCapabilities("c1", "q")).toMatchObject({ images: false, thinking: false });
    await getCapabilities("c1", "q");
    expect(asked.filter((u) => u.includes("/props?"))).toHaveLength(1);
  });

  it("gives what the list said when the model can't answer, and doesn't ask on every request", async () => {
    vi.useFakeTimers();
    list = [{ ...LIST_ENTRY, id: "q", status: { value: "unloaded" } }];
    await listModels("c1");
    expect((await getCapabilities("c1", "q"))?.images).toBe(true);
    expect((await getCapabilities("c1", "q"))?.thinking).toBeUndefined();
    expect(asked.filter((u) => u.includes("/props?"))).toHaveLength(1);
    // Later (the model was loaded meanwhile) it asks again and learns.
    props = { q: QWEN_PROPS };
    vi.advanceTimersByTime(20000);
    expect((await getCapabilities("c1", "q"))?.thinking).toBe(true);
  });

  it("knows nothing about a model it was never told of and can't ask", async () => {
    expect(await getCapabilities("c1", "nope")).toBeUndefined();
  });
});

const withImage: ChatMessage[] = [{ role: "user", content: "what is this?", images: [{ id: "i1", mediaType: "image/png" }] }];
const imageData = { i1: "AAAA" };
const hasImageBlock = (b: any) => JSON.stringify(b).includes('"type":"image') || JSON.stringify(b).includes("image_url");

describe("a request never sends an image to a model that says it takes none", () => {
  const base = { connectorId: "c1", purpose: { kind: "background" } as const, messages: withImage, images: imageData };
  const run = (req: object) => streamChat({ ...base, ...req } as any, () => {}, new AbortController().signal);

  it("Claude: Opus 5.5 (no image input) gets the text and a note, no image block", async () => {
    await run({ kind: "anthropic", api: "anthropic", model: "claude-opus-5-5" });
    expect(chatBodies).toHaveLength(1);
    expect(hasImageBlock(chatBodies[0])).toBe(false);
    expect(JSON.stringify(chatBodies[0].messages)).toContain("not sent: this model can't read images");
  });

  it("Claude: Sonnet 5.5 (images) gets the image", async () => {
    await run({ kind: "anthropic", api: "anthropic", model: "claude-sonnet-5-5" });
    expect(hasImageBlock(chatBodies[0])).toBe(true);
  });

  for (const api of ["anthropic", "openai"] as const) {
    it(`llama.cpp over ${api}: a model whose /props says no vision gets no image`, async () => {
      props = { plain: PLAIN_PROPS, qwen: QWEN_PROPS };
      await run({ kind: "llama", api, model: "plain" });
      expect(hasImageBlock(chatBodies[0])).toBe(false);
      await run({ kind: "llama", api, model: "qwen" });
      expect(hasImageBlock(chatBodies[1])).toBe(true);
    });
  }

  it("llama.cpp: a model that says nothing still gets images, as before", async () => {
    await run({ kind: "llama", api: "openai", model: "silent" });
    expect(hasImageBlock(chatBodies[0])).toBe(true);
  });

  it("withoutImages leaves the saved chat alone and other messages as they are", () => {
    const chat: ChatMessage[] = [...withImage, { role: "assistant", content: "hm" }];
    const out = withoutImages(chat);
    expect(out[0].images).toBeUndefined();
    expect(out[0].content).toContain("An image was attached here but not sent");
    expect(out[1]).toBe(chat[1]);
    expect(chat[0].images).toHaveLength(1);
  });
});
