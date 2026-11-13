import { describe, expect, it } from "vitest";
import { cleanPersona, personaIsFixed, personaToSave, withChosenPersona, withFrozenPersona } from "../persona";
import { emptySessionState, fromSession, toSession } from "../sessionState";

const started = { messages: [{}], promptDir: undefined as string | null | undefined };
const empty = { messages: [], promptDir: undefined as string | null | undefined };

describe("when a persona is fixed", () => {
  it("is open on an empty chat and fixed once there is a message or a prompt folder", () => {
    expect(personaIsFixed(empty)).toBe(false);
    expect(personaIsFixed(started)).toBe(true);
    // Fixed at the first reply even if the messages were cleared away.
    expect(personaIsFixed({ messages: [], promptDir: null })).toBe(true);
  });

  it("lets the picker choose before the first message and refuses after", () => {
    const chosen = withChosenPersona({ ...empty, persona: undefined as string | undefined }, "Reviewer");
    expect(chosen.persona).toBe("Reviewer");
    expect(withChosenPersona({ ...chosen, persona: "Reviewer" }, "Builder").persona).toBe("Builder");

    const locked = { ...started, persona: "Reviewer" };
    expect(withChosenPersona(locked, "Builder")).toBe(locked);
  });

  it("records the prompt's persona at the first reply, and never replaces one already saved", () => {
    expect(withFrozenPersona({ persona: undefined }, "Builder").persona).toBe("Builder");
    expect(withFrozenPersona({ persona: "Reviewer" }, "Builder").persona).toBe("Reviewer");
    const none = { persona: undefined };
    expect(withFrozenPersona(none, undefined)).toBe(none);
  });

  it("keeps the saved name on a save once started, and takes the sent one before", () => {
    expect(personaToSave(undefined, "Reviewer")).toBe("Reviewer");
    expect(personaToSave({ ...empty, persona: "Builder" }, "Reviewer")).toBe("Reviewer");
    expect(personaToSave({ ...started, persona: "Builder" }, "Reviewer")).toBe("Builder");
    expect(personaToSave({ ...started }, "Reviewer")).toBeUndefined();
  });

  it("reads only text with something in it as a name", () => {
    expect(cleanPersona(" Builder ")).toBe("Builder");
    expect(cleanPersona("  ")).toBeUndefined();
    expect(cleanPersona(3)).toBeUndefined();
  });
});

describe("the persona in a saved session", () => {
  it("is saved by name and reopens as it was", () => {
    const state = { ...emptySessionState(), persona: "Reviewer" };
    const session = toSession(state, { id: "a", model: "m" });
    expect(session.persona).toBe("Reviewer");
    expect(fromSession(session).persona).toBe("Reviewer");
  });

  it("is undefined for a session saved before personas", () => {
    const session = toSession(emptySessionState(), { id: "a", model: "m" });
    expect(fromSession(session).persona).toBeUndefined();
  });
});
