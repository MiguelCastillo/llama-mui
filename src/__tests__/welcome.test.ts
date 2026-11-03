import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WELCOME_HIDDEN_KEY,
  afterSave,
  hasWelcomeMarker,
  setWelcomeHidden,
  settingsHash,
  welcomeBannerStep,
  welcomeDone,
  welcomeHidden,
  welcomeRedirect,
  welcomeSteps,
} from "../welcomeState";
import { pickModel } from "../modelChoice";

const llama = { kind: "llama" as const, defaultModel: "m" };
const anthropic = { kind: "anthropic" as const, defaultModel: "claude" };
const models = (status?: string, id = "m") => [{ id, status: status as string }];

afterEach(() => vi.unstubAllGlobals());

describe("welcomeSteps", () => {
  it("has nothing done without a connector", () => {
    expect(welcomeSteps({ connector: null, connection: undefined, models: [] })).toEqual({ connect: false, choose: false });
  });

  it("does not count a saved server whose test fails, or one still being tested", () => {
    expect(welcomeSteps({ connector: llama, connection: "failed", models: models("loaded") })).toEqual({
      connect: false,
      choose: false,
    });
    expect(welcomeSteps({ connector: llama, connection: undefined, models: [] }).connect).toBe(false);
  });

  it("ticks step 1 on a passing test; a loaded model alone is not a choice", () => {
    const noDefault = { kind: "llama" as const };
    expect(welcomeSteps({ connector: noDefault, connection: "ok", models: models("loaded") })).toEqual({
      connect: true,
      choose: false,
    });
  });

  it("ticks step 2 when the default is listed and loaded", () => {
    const done = welcomeSteps({ connector: llama, connection: "ok", models: models("loaded") });
    expect(done).toEqual({ connect: true, choose: true });
    expect(welcomeDone(done)).toBe(true);
  });

  it("waits while the default is unloaded or loading, or the server doesn't list it", () => {
    expect(welcomeSteps({ connector: llama, connection: "ok", models: models("unloaded") }).choose).toBe(false);
    expect(welcomeSteps({ connector: llama, connection: "ok", models: models("loading") }).choose).toBe(false);
    expect(welcomeSteps({ connector: llama, connection: "ok", models: models("loaded", "other") }).choose).toBe(false);
    expect(welcomeSteps({ connector: llama, connection: "ok", models: [] }).choose).toBe(false);
  });

  it("treats a server that reports no status as having nothing to load", () => {
    expect(welcomeSteps({ connector: llama, connection: "ok", models: models(undefined) }).choose).toBe(true);
    expect(welcomeSteps({ connector: llama, connection: "ok", models: models("unknown") }).choose).toBe(true);
  });

  it("for Anthropic needs a chosen, listed model and a passing test, and nothing to load", () => {
    expect(welcomeSteps({ connector: anthropic, connection: "ok", models: models(undefined, "claude") })).toEqual({
      connect: true,
      choose: true,
    });
    expect(welcomeSteps({ connector: anthropic, connection: "ok", models: models(undefined, "other") }).choose).toBe(false);
    expect(welcomeSteps({ connector: { kind: "anthropic" }, connection: "ok", models: models(undefined, "claude") }).choose).toBe(
      false,
    );
    expect(welcomeSteps({ connector: anthropic, connection: "failed", models: models(undefined, "claude") })).toEqual({
      connect: false,
      choose: false,
    });
  });

  it("stays on a finish state while both are done, whatever else changes", () => {
    const s = welcomeSteps({ connector: llama, connection: "ok", models: [...models("loaded"), ...models("loaded", "x")] });
    expect(welcomeDone(s)).toBe(true);
  });
});

describe("pickModel", () => {
  const ms = [
    { id: "a", status: "unloaded" },
    { id: "b", status: "loaded" },
    { id: "c", status: "unloaded" },
  ];
  it("keeps the current pick if listed", () => {
    expect(pickModel({ current: "c", defaultModel: "a", models: ms })).toBe("c");
  });
  it("then the default if listed", () => {
    expect(pickModel({ current: "", defaultModel: "a", models: ms })).toBe("a");
    expect(pickModel({ current: "gone", defaultModel: "c", models: ms })).toBe("c");
  });
  it("then a loaded model, then the first", () => {
    expect(pickModel({ current: "", defaultModel: "missing", models: ms })).toBe("b");
    expect(pickModel({ current: "", models: ms })).toBe("b");
    expect(pickModel({ current: "", models: [ms[0], ms[2]] })).toBe("a");
  });
  it("starts a new session on the default, whatever the tab last used", () => {
    // newChat asks with no current pick.
    expect(pickModel({ current: "", defaultModel: "c", models: ms })).toBe("c");
    expect(pickModel({ current: "", defaultModel: "gone", models: ms })).toBe("b");
    expect(pickModel({ current: "", defaultModel: undefined, models: [ms[0], ms[2]] })).toBe("a");
  });
  it("is empty with no models", () => {
    expect(pickModel({ current: "x", defaultModel: "y", models: [] })).toBe("");
  });
});

describe("welcomeRedirect", () => {
  it("waits until the connector list has answered", () => {
    expect(welcomeRedirect({ connectorCount: undefined, hidden: false })).toBe("wait");
  });
  it("redirects a first-time user", () => {
    expect(welcomeRedirect({ connectorCount: 0, hidden: false })).toBe("redirect");
  });
  it("never redirects a user with a connector, even if its server is down", () => {
    expect(welcomeRedirect({ connectorCount: 1, hidden: false })).toBe("stay");
  });
  it("does not redirect once the checklist is exited or finished", () => {
    expect(welcomeRedirect({ connectorCount: 0, hidden: true })).toBe("stay");
  });
});

describe("the hash marker", () => {
  it("is found on a settings address and not on others", () => {
    expect(hasWelcomeMarker("#/settings/connectors?from=welcome")).toBe(true);
    expect(hasWelcomeMarker("#/settings/models?x=1&from=welcome")).toBe(true);
    expect(hasWelcomeMarker("#/settings/models")).toBe(false);
    expect(hasWelcomeMarker("#/settings/models?from=welcomed")).toBe(false);
    expect(hasWelcomeMarker("")).toBe(false);
  });

  it("builds addresses the existing route parsing still reads", () => {
    const route = /^#\/settings(?:\/([\w-]+))?/;
    expect(settingsHash("models", true)).toBe("#/settings/models?from=welcome");
    expect(settingsHash("models", true).match(route)![1]).toBe("models");
    expect(settingsHash("tools")).toBe("#/settings/tools");
  });

  it("names the step in the banner", () => {
    expect(welcomeBannerStep("connectors")).toBe("step 1: Connect a server");
    expect(welcomeBannerStep("models")).toBe("step 2: Load a model");
    expect(welcomeBannerStep("chat")).toBe("");
  });
});

describe("exit and reopen", () => {
  function fakeStorage(broken = false) {
    const data = new Map<string, string>();
    const fail = () => {
      if (broken) throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (fail(), data.get(k) ?? null),
      setItem: (k: string, v: string) => (fail(), void data.set(k, v)),
      removeItem: (k: string) => (fail(), void data.delete(k)),
    });
    return data;
  }

  it("remembers Exit and forgets it on Show getting started", () => {
    const data = fakeStorage();
    expect(welcomeHidden()).toBe(false);
    setWelcomeHidden(true);
    expect(data.get(WELCOME_HIDDEN_KEY)).toBe("true");
    expect(welcomeHidden()).toBe(true);
    setWelcomeHidden(false);
    expect(welcomeHidden()).toBe(false);
  });

  it("works without localStorage", () => {
    fakeStorage(true);
    expect(welcomeHidden()).toBe(false);
    expect(() => setWelcomeHidden(true)).not.toThrow();
    expect(() => setWelcomeHidden(false)).not.toThrow();
  });
});

describe("afterSave", () => {
  it("returns to the checklist when saved from it and the test passes", () => {
    expect(afterSave({ marker: true, test: { ok: true } })).toBe("return");
  });
  it("stays in the dialog when the test fails or didn't run", () => {
    expect(afterSave({ marker: true, test: { ok: false } })).toBe("stay");
    expect(afterSave({ marker: true, test: undefined })).toBe("stay");
  });
  it("just closes without the marker, whatever the test", () => {
    expect(afterSave({ marker: false, test: undefined })).toBe("close");
    expect(afterSave({ marker: false, test: { ok: false } })).toBe("close");
  });
});
