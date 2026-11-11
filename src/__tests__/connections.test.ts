import { describe, expect, it } from "vitest";
import { MODELS } from "./capabilityFixtures";
import { InvalidOptions, type Purpose, connection, optionsFor, readCapabilities, readModelOptions, validateShape } from "../connections/index";

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
    expect(haiku).toEqual({ adaptiveThinking: false, efforts: [] });
  });
  it("reads Sonnet 5.5 and Opus 5.5: adaptive thinking, every effort level", () => {
    expect(sonnet).toEqual({ adaptiveThinking: true, efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(opus).toEqual(sonnet);
  });
  it("reads each level's own flag, and counts anything missing as unsupported", () => {
    const some = { capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true } } } };
    expect(readCapabilities(some).efforts).toEqual(["low", "high"]);
    expect(readCapabilities({})).toEqual({ adaptiveThinking: false, efforts: [] });
    expect(readCapabilities(null)).toEqual({ adaptiveThinking: false, efforts: [] });
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
