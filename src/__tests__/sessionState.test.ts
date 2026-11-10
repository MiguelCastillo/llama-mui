import { describe, expect, it } from "vitest";
import type { Session } from "../api";
import { INTERRUPTED } from "../agent/helpers";
import { emptySessionState, fromSession, stateKey, toSession, type SessionState } from "../sessionState";

const bare = { id: "x", title: "t", model: "m" } as Session;

const planOf = (status: string) =>
  [
    { id: "a", text: "First", status },
    { id: "b", text: "Second", status: "pending" },
  ] as Session["plan"];

describe("sessionState", () => {
  it("opens a session that lacks most fields with a default for each", () => {
    const state = fromSession(bare);
    expect(state).toEqual(emptySessionState());
  });

  it("pins plans from older sessions after the last message", () => {
    const state = fromSession({
      ...bare,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ],
      plan: planOf("pending"),
      pastPlans: [{ steps: planOf("done"), anchor: null }],
    } as unknown as Session);
    expect(state.planAnchor).toBe("at:2");
    expect(state.pastPlans[0].anchor).toBe("at:2");
  });

  it("keeps a plan's own anchor and gives no anchor without a plan", () => {
    expect(fromSession({ ...bare, plan: planOf("pending"), planAnchor: "turn-1" }).planAnchor).toBe("turn-1");
    expect(fromSession({ ...bare, plan: null, planAnchor: "turn-1" }).planAnchor).toBeNull();
  });

  it("gives steps without an id one", () => {
    const state = fromSession({
      ...bare,
      plan: [{ text: "No id", status: "pending" }],
    } as unknown as Session);
    expect(state.plan?.[0].id).toBeTruthy();
  });

  it("resets a running step to pending unless the session is live", () => {
    const saved = { ...bare, plan: planOf("running") };
    expect(fromSession(saved).plan?.[0].status).toBe("pending");
    expect(fromSession(saved, { live: true }).plan?.[0].status).toBe("running");
  });

  it("hides the interrupted mark only while the run is going", () => {
    const saved = { ...bare, failed: INTERRUPTED };
    expect(fromSession(saved).failed).toBe(INTERRUPTED);
    expect(fromSession(saved, { live: true }).failed).toBeNull();
    expect(fromSession(saved, { live: true, running: false }).failed).toBe(INTERRUPTED);
    expect(fromSession({ ...bare, failed: "boom" }, { live: true }).failed).toBe("boom");
  });

  it("round trips: a state saved and opened again is the same state", () => {
    const state = {
      ...emptySessionState(),
      messages: [{ role: "user", content: "hello" }],
      contextStart: 1,
      workingDir: "/tmp/w",
      promptDir: "/tmp/w",
      modelName: "Greeting",
      plan: planOf("done"),
      planAnchor: "at:1",
      planContext: "ctx",
      planSummary: "sum",
      planId: "p1",
      todos: [],
      parentId: "parent",
      titleHint: "hint",
      planMovedIn: true,
      autoApprove: { commands: true },
    } as ReturnType<typeof emptySessionState>;
    const saved = toSession(state, { id: "x", model: "m" });
    expect(fromSession(saved)).toEqual(state);
  });

  it("titles the session by the model's name, else the hint, else the first message", () => {
    const messages = [{ role: "user", content: "a".repeat(100) }] as Session["messages"];
    const base = { ...emptySessionState(), messages };
    const title = (s: Partial<typeof base>) => toSession({ ...base, ...s }, { id: "x", model: "m" }).title;
    expect(title({ modelName: "Named", titleHint: "Hint" })).toBe("Named");
    expect(title({ titleHint: "Hint" })).toBe("Hint");
    expect(title({})).toBe("a".repeat(80));
    expect(toSession(emptySessionState(), { id: "x", model: "m" }).title).toBe("New session");
  });

  it("carries the id and model it is given", () => {
    const s = toSession(emptySessionState(), { id: "abc", model: "big" });
    expect(s.id).toBe("abc");
    expect(s.model).toBe("big");
  });

  it("saves the connection it is given, and leaves it out without one", () => {
    expect(toSession(emptySessionState(), { id: "x", model: "m", connectorId: "c-1" }).connectorId).toBe("c-1");
    expect("connectorId" in toSession(emptySessionState(), { id: "x", model: "m" })).toBe(false);
    expect("connectorId" in toSession(emptySessionState(), { id: "x", model: "m", connectorId: null })).toBe(false);
  });

  it("tells two sessions on different connections apart", () => {
    const a = toSession(emptySessionState(), { id: "x", model: "m", connectorId: "c-1" });
    const b = toSession(emptySessionState(), { id: "x", model: "m", connectorId: "c-2" });
    expect(stateKey(a)).not.toBe(stateKey(b));
    expect(stateKey(a)).toBe(stateKey({ ...a }));
  });

  it("saves autoApprove only when something is approved", () => {
    const none = toSession(emptySessionState(), { id: "x", model: "m" });
    expect("autoApprove" in none).toBe(false);
    const some = toSession({ ...emptySessionState(), autoApprove: { changes: true } }, { id: "x", model: "m" });
    expect(some.autoApprove).toEqual({ changes: true });
  });

  it("saves every field of the state, and nothing else besides id, title and model", () => {
    const state = { ...emptySessionState(), autoApprove: { commands: true } };
    const saved = toSession(state, { id: "x", model: "m" });
    const savedKeys = Object.keys(saved).filter((k) => !["id", "title", "model", "connectorId"].includes(k));
    expect(savedKeys.sort()).toEqual(Object.keys(state).sort());
  });

  describe("stateKey", () => {
    const saved = (state: SessionState, model = "m") => toSession(state, { id: "x", model });
    // A value different from the empty one, for every field. Typed as a record of
    // every field, so a field added to the state fails to compile here until it is placed.
    const changed: Record<keyof SessionState, unknown> = {
      messages: [{ role: "user", content: "hi" }],
      contextStart: 1,
      attachments: [{ path: "/a", kind: "file" }],
      workingDir: "/w",
      promptDir: "/p",
      usage: { total: 1 },
      failed: "boom",
      modelName: "Named",
      plan: planOf("pending"),
      planProposal: planOf("pending"),
      planContext: "ctx",
      planSummary: "sum",
      planId: "p1",
      planAnchor: "at:1",
      pastPlans: [{ steps: planOf("done"), anchor: "at:0" }],
      todos: [{ id: "t", summary: "Do it", description: "", context: "", status: "open", createdAt: 1 }],
      parentId: "parent",
      threads: [{ id: "th" }],
      titleHint: "hint",
      planMovedIn: true,
      autoApprove: { commands: true },
    };

    it("differs when any field of the state differs", () => {
      const base = stateKey(saved(emptySessionState()));
      for (const key of Object.keys(emptySessionState()) as (keyof SessionState)[]) {
        const next = { ...emptySessionState(), [key]: changed[key] } as SessionState;
        expect(stateKey(saved(next)), key).not.toBe(base);
      }
    });

    it("differs when the model differs", () => {
      expect(stateKey(saved(emptySessionState(), "a"))).not.toBe(stateKey(saved(emptySessionState(), "b")));
    });

    it("ignores the id and the title", () => {
      const a = { ...saved(emptySessionState()), id: "one", title: "First" };
      const b = { ...saved(emptySessionState()), id: "two", title: "Second" };
      expect(stateKey(a)).toBe(stateKey(b));
    });

    it("counts a missing field as an empty one", () => {
      expect(stateKey(bare)).toBe(stateKey(saved(emptySessionState())));
      expect(stateKey({ ...bare, autoApprove: {} })).toBe(stateKey(bare));
    });

    it("is the same for a state saved and opened again", () => {
      const state = { ...emptySessionState(), ...changed } as SessionState;
      const session = saved(state);
      expect(stateKey({ ...session, ...fromSession(session) })).toBe(stateKey(session));
    });
  });

  it("keeps every saved session key in the state, except the ones the server owns", () => {
    // Session's own fields (api.ts): each is either held by the state or set by the server.
    const serverOwned = ["userName", "group", "revision", "run"];
    // Typed as a record of every key, so a field added to Session fails to compile here until it is placed.
    const all: Record<keyof Session, true> = {
      id: true, title: true, model: true, connectorId: true, messages: true, contextStart: true, attachments: true,
      workingDir: true, usage: true, failed: true, plan: true, planProposal: true, planContext: true,
      planSummary: true, planAnchor: true, planId: true, pastPlans: true, promptDir: true, modelName: true,
      userName: true, group: true, todos: true, parentId: true, threads: true, autoApprove: true,
      titleHint: true, planMovedIn: true, revision: true, run: true,
    };
    const everySessionKey = Object.keys(all) as (keyof Session)[];
    const stateKeys = Object.keys(emptySessionState());
    for (const key of everySessionKey) {
      if (["id", "title", "model", "connectorId", ...serverOwned].includes(key)) continue;
      expect(stateKeys, key).toContain(key);
    }
  });
});
