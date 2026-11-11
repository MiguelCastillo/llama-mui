import { describe, expect, it } from "vitest";
import { LIST_ENTRY, MODELS, PLAIN_PROPS, QWEN_PROPS } from "./capabilityFixtures";
import { InvalidOptions, type Purpose, capabilitiesFromList, connection, optionsFor, readCapabilities, readList, readModelOptions, readProps, validateShape } from "../connections/index";

// Each connection kind's module: the settings a model has, whether a settings
// object is valid, and the request fields it turns into, by purpose. The
// capabilities are the Models API's real answers (capabilityFixtures).

const haiku = readCapabilities(MODELS["claude-haiku-4-5-20251001"]);
const sonnet = readCapabilities(MODELS["claude-sonnet-5-5"]);
const opus = readCapabilities(MODELS["claude-opus-5-5"]);
const claude = connection("anthropic");
const llama = connection("llama");

const PURPOSES: Purpose[] = [
  { kind: "reply", round: 0 },
  { kind: "reply", round: 1 },
  { kind: "planning", round: 0 },
  { kind: "planning", round: 2 },
  { kind: "planStep", round: 0 },
  { kind: "planStep", round: 1 },
  { kind: "stepCheck", round: 0 },
  { kind: "stepCheck", round: 1 },
  { kind: "aside", round: 0 },
  { kind: "aside", round: 1 },
  { kind: "background" },
];
const ADAPTIVE = { type: "adaptive", display: "summarized" };

describe("reading a model's capabilities", () => {
  it("reads Haiku 4.5: no adaptive thinking, no effort", () => {
    expect(haiku).toMatchObject({ adaptiveThinking: false, efforts: [] });
  });
  it("reads Sonnet 5.5 and Opus 5.5: adaptive thinking, every effort level", () => {
    expect(sonnet).toMatchObject({ adaptiveThinking: true, efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(opus).toMatchObject({ adaptiveThinking: true, efforts: sonnet.efforts });
  });
  it("reads each level's own flag, and counts anything missing as unsupported", () => {
    const some = { capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true } } } };
    expect(readCapabilities(some).efforts).toEqual(["low", "high"]);
    expect(readCapabilities({})).toEqual({ adaptiveThinking: false, efforts: [] });
    expect(readCapabilities(null)).toEqual({ adaptiveThinking: false, efforts: [] });
  });
});

describe("the common facts", () => {
  it("reads Claude's images, PDFs, thinking, context size, most output and lifecycle", () => {
    expect(sonnet).toMatchObject({ images: true, pdf: true, thinking: true, contextSize: 1000000, maxOutput: 128000 });
    expect(sonnet.deprecated).toBeUndefined();
    expect(haiku).toMatchObject({ images: true, thinking: true, deprecated: true, retiresAt: "2027-02-01T00:00:00Z" });
    expect(opus).toMatchObject({ images: false, pdf: false });
  });
  it("leaves what the API doesn't say unknown, not false", () => {
    const bare = readCapabilities({ capabilities: { effort: { supported: false } } });
    expect(bare.images).toBeUndefined();
    expect(bare.pdf).toBeUndefined();
    expect(bare.thinking).toBeUndefined();
    expect(bare.contextSize).toBeUndefined();
    expect(readCapabilities(null)).toEqual({ adaptiveThinking: false, efforts: [] });
  });
  it("reads llama.cpp's list: images from input_modalities, nothing when it says none", () => {
    expect(readList(LIST_ENTRY)).toMatchObject({ images: true });
    expect(readList({ architecture: { input_modalities: ["text"] } })).toMatchObject({ images: false });
    expect(readList({ architecture: {} })).toBeUndefined();
    expect(readList({ id: "x" })).toBeUndefined();
    expect(capabilitiesFromList(LIST_ENTRY)?.images).toBe(true);
    expect(capabilitiesFromList(MODELS["claude-sonnet-5-5"])?.contextSize).toBe(1000000);
  });
  it("reads llama.cpp's /props: vision, a thinking template, the template's effort levels", () => {
    expect(readProps(QWEN_PROPS)).toMatchObject({ images: true, thinking: true, reasoningEffortLevels: [] });
    expect(readProps(PLAIN_PROPS)).toMatchObject({ images: false, thinking: false });
  });
  it("lets /props win over the list, and keeps the list's word when /props is silent", () => {
    const fromList = { adaptiveThinking: false, efforts: [], images: true };
    expect(readProps({ modalities: { vision: false } }, fromList).images).toBe(false);
    const silent = readProps({}, fromList);
    expect(silent.images).toBe(true);
    expect(silent.thinking).toBeUndefined();
    expect(silent.reasoningEffortLevels).toBeUndefined();
  });
  it("asks Claude at /v1/models/<id> and llama.cpp at /props, without loading the model", () => {
    expect(claude.capabilitiesPath("claude-sonnet-5-5")).toBe("/v1/models/claude-sonnet-5-5");
    expect(llama.capabilitiesPath("a/b:Q4")).toBe("/props?model=a%2Fb%3AQ4&autoload=false");
  });
});

describe("llama.cpp's Think", () => {
  it("is offered unless the template is known to have no thinking switch", () => {
    expect(llama.knobs(undefined).map((k) => k.key)).toEqual(["think"]);
    expect(llama.knobs(readProps(QWEN_PROPS)).map((k) => k.key)).toEqual(["think"]);
    expect(llama.knobs(readProps({ modalities: { vision: true } })).map((k) => k.key)).toEqual(["think"]);
    expect(llama.knobs(readProps(PLAIN_PROPS))).toEqual([]);
  });
  it("is left out of what a message carries for a model with no switch", () => {
    expect(optionsFor("llama", { think: true }, readProps(PLAIN_PROPS))).toEqual({});
    expect(optionsFor("llama", { think: true }, readProps(QWEN_PROPS))).toEqual({ think: true });
  });
  it("keeps its rule: first request of a reply only, not planning, not background", () => {
    const on = { think: true };
    const t = (purpose: Purpose) => (llama.fields(on, purpose, readProps(QWEN_PROPS)) as any).chat_template_kwargs.enable_thinking;
    expect(t({ kind: "reply", round: 0 })).toBe(true);
    expect(t({ kind: "reply", round: 1 })).toBe(false);
    expect(t({ kind: "planning", round: 0 })).toBe(false);
    expect(t({ kind: "background" })).toBe(false);
  });
});

describe("the knobs", () => {
  it("give a Claude model Effort with only the levels it supports", () => {
    expect(claude.knobs(sonnet).map((k) => k.key)).toEqual(["effort"]);
    const partial = { adaptiveThinking: true, efforts: ["low", "high"] as ("low" | "high")[] };
    expect(claude.knobs(partial)).toMatchObject([{ key: "effort", levels: ["low", "high"] }]);
  });
  it("give Haiku 4.5 no Effort at all, and nothing is shown before capabilities are known", () => {
    expect(claude.knobs(haiku)).toEqual([]);
    expect(claude.knobs(undefined)).toEqual([]);
  });
  it("give a llama.cpp model Think", () => {
    expect(llama.knobs().map((k) => k.key)).toEqual(["think"]);
  });
});

describe("validation", () => {
  it("accepts a supported effort level for Claude, and drops Think", () => {
    expect(claude.validate({ think: true, effort: "xhigh" }, sonnet)).toEqual({ effort: "xhigh" });
    expect(claude.validate({}, haiku)).toEqual({});
    expect(claude.validate({ effort: null }, haiku)).toEqual({});
  });
  it("rejects an unsupported level, and any effort for a model that takes none", () => {
    const some = { adaptiveThinking: true, efforts: ["low" as const] };
    expect(() => claude.validate({ effort: "max" }, some)).toThrow(InvalidOptions);
    expect(() => claude.validate({ effort: "max" }, some)).toThrow(/takes: low/);
    expect(() => claude.validate({ effort: "low" }, haiku)).toThrow(/no effort setting/);
  });
  it("rejects a value that isn't a level, with or without capabilities", () => {
    expect(() => claude.validate({ effort: "extreme" })).toThrow(/effort must be one of low, medium, high, xhigh, max/);
    expect(() => claude.validate({ effort: 3 }, sonnet)).toThrow(InvalidOptions);
    // Without capabilities, a level is accepted by shape.
    expect(claude.validate({ effort: "max" })).toEqual({ effort: "max" });
  });
  it("checks llama.cpp's Think, and drops an effort", () => {
    expect(llama.validate({ think: true, effort: "high" })).toEqual({ think: true });
    expect(llama.validate({})).toEqual({});
    expect(() => llama.validate({ think: "yes" })).toThrow(/think must be true or false/);
  });
  it("checks by shape alone when the connection isn't known", () => {
    expect(validateShape({ think: true, effort: "low", other: 1 })).toEqual({ think: true, effort: "low" });
    expect(() => validateShape({ effort: "extreme" })).toThrow(InvalidOptions);
    expect(() => validateShape({ think: 1 })).toThrow(InvalidOptions);
  });
});

describe("what a message carries for a model", () => {
  it("is Think for llama.cpp, always a boolean", () => {
    expect(optionsFor("llama", { think: true, effort: "low" })).toEqual({ think: true });
    expect(optionsFor("llama", undefined)).toEqual({ think: false });
    expect(optionsFor(undefined, { think: true })).toEqual({ think: true });
  });
  it("is the effort for a Claude model that takes it, and nothing for one that doesn't", () => {
    expect(optionsFor("anthropic", { think: true, effort: "high" }, sonnet)).toEqual({ effort: "high" });
    expect(optionsFor("anthropic", { think: true, effort: "high" }, haiku)).toEqual({});
    expect(optionsFor("anthropic", { think: true, effort: "high" }, undefined)).toEqual({});
    expect(optionsFor("anthropic", { think: true }, sonnet)).toEqual({});
  });
  it("leaves out a saved level the model doesn't take", () => {
    expect(optionsFor("anthropic", { think: false, effort: "max" }, { adaptiveThinking: true, efforts: ["low"] })).toEqual({});
  });
});

describe("Claude's request fields", () => {
  it("ask for adaptive thinking on every purpose, with the effort when set (Sonnet 5.5)", () => {
    for (const purpose of PURPOSES) {
      const fields = claude.fields({ effort: "high" }, purpose, sonnet);
      expect(fields).toEqual({ thinking: ADAPTIVE, output_config: { effort: "high" }, cache_control: { type: "ephemeral" } });
      expect(claude.fields({}, purpose, sonnet)).toEqual({ thinking: ADAPTIVE, cache_control: { type: "ephemeral" } });
    }
  });
  it("ask for neither on Haiku 4.5, even with an effort in the settings", () => {
    for (const purpose of PURPOSES) {
      expect(claude.fields({ effort: "high" }, purpose, haiku)).toEqual({ cache_control: { type: "ephemeral" } });
    }
  });
  it("send no effort for a level the model doesn't take", () => {
    expect(claude.fields({ effort: "max" }, PURPOSES[0], { adaptiveThinking: true, efforts: ["low"] })).not.toHaveProperty("output_config");
  });
  it("send nothing optional without capabilities", () => {
    expect(claude.fields({ effort: "high" }, PURPOSES[0], undefined)).toEqual({ cache_control: { type: "ephemeral" } });
  });
  it("keep thinking, with no effort, for a background call", () => {
    expect(claude.fields(undefined, { kind: "background" }, opus)).toEqual({ thinking: ADAPTIVE, cache_control: { type: "ephemeral" } });
  });
});

describe("llama.cpp's request fields, as before", () => {
  const think = (options: object | undefined, purpose: Purpose) => (llama.fields(options, purpose) as any).chat_template_kwargs.enable_thinking;
  const expected: [Purpose, boolean][] = [
    [{ kind: "reply", round: 0 }, true],
    [{ kind: "reply", round: 1 }, false],
    [{ kind: "planning", round: 0 }, false],
    [{ kind: "planning", round: 1 }, false],
    [{ kind: "planStep", round: 0 }, true],
    [{ kind: "planStep", round: 3 }, false],
    [{ kind: "stepCheck", round: 0 }, true],
    [{ kind: "stepCheck", round: 1 }, false],
    [{ kind: "aside", round: 0 }, true],
    [{ kind: "aside", round: 1 }, false],
    [{ kind: "background" }, false],
  ];
  it("think only on a reply, step, check or side question's first request, with Think on", () => {
    for (const [purpose, want] of expected) expect(think({ think: true }, purpose)).toBe(want);
  });
  it("never think with Think off or missing", () => {
    for (const [purpose] of expected) {
      expect(think({ think: false }, purpose)).toBe(false);
      expect(think({}, purpose)).toBe(false);
      expect(think(undefined, purpose)).toBe(false);
    }
  });
  it("send only chat_template_kwargs", () => {
    expect(llama.fields({ think: true, effort: "high" }, PURPOSES[0])).toEqual({ chat_template_kwargs: { enable_thinking: true } });
  });
});

describe("reading a settings object that may be older", () => {
  it("prefers modelOptions, and falls back to thinkOn and effort", () => {
    expect(readModelOptions({ modelOptions: { think: true }, thinkOn: false, effort: "low" })).toEqual({ think: true });
    expect(readModelOptions({ thinkOn: true, effort: "low" })).toEqual({ think: true, effort: "low" });
    expect(readModelOptions({ thinkOn: "x", effort: "lots" })).toEqual({});
    expect(readModelOptions(undefined)).toEqual({});
  });
});
