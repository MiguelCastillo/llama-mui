import { describe, expect, it } from "vitest";
import type { Session } from "../api";
import { withSessionDefaults } from "../sessionDefaults";

describe("withSessionDefaults", () => {
  it("fills what a shared session may lack", () => {
    const s = withSessionDefaults({ id: "x", title: "t", model: "m" } as Session);
    expect(s).toMatchObject({
      messages: [],
      contextStart: 0,
      attachments: [],
      usage: null,
      failed: null,
      plan: null,
      planSummary: null,
      pastPlans: [],
      todos: [],
    });
  });

  it("loads an old session whose plan has no summaries", () => {
    const s = withSessionDefaults({
      id: "x",
      title: "t",
      model: "m",
      plan: [{ id: "a", text: "Do the thing", status: "done" }],
      pastPlans: [{ steps: [{ id: "b", text: "Older", status: "done" }], anchor: null }],
    } as unknown as Session);
    expect(s.planSummary).toBeNull();
    expect(s.plan).toEqual([{ id: "a", text: "Do the thing", status: "done" }]);
    expect(s.plan?.[0].summary).toBeUndefined();
    expect(s.pastPlans?.[0].summary).toBeUndefined();
  });

  it("keeps the plan summary and step summaries", () => {
    const s = withSessionDefaults({
      id: "x",
      title: "t",
      model: "m",
      plan: [{ id: "a", text: "Do it", summary: "Do it now", status: "pending" }],
      planSummary: "Adds a thing",
    } as unknown as Session);
    expect(s.planSummary).toBe("Adds a thing");
    expect(s.plan?.[0].summary).toBe("Do it now");
  });

  it("keeps what is there", () => {
    const s = withSessionDefaults({
      id: "x",
      title: "t",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      contextStart: 1,
      attachments: [{ path: "/a", kind: "folder", source: "user" }],
      todos: [{ id: "a", summary: "s", description: "d", context: "c", status: "done", createdAt: 3 }],
    } as unknown as Session);
    expect(s.messages).toHaveLength(1);
    expect(s.contextStart).toBe(1);
    expect(s.attachments).toHaveLength(1);
    expect(s.todos).toEqual([{ id: "a", summary: "s", description: "d", context: "c", status: "done", createdAt: 3 }]);
  });

  it("gives an old session no parent", () => {
    expect(withSessionDefaults({ id: "x", title: "t", model: "m" } as Session).parentId).toBeNull();
    expect(withSessionDefaults({ id: "x", title: "t", model: "m", parentId: 5 } as unknown as Session).parentId).toBeNull();
  });

  it("gives an old session no connection and keeps a saved one", () => {
    const old = withSessionDefaults({ id: "x", title: "t", model: "m" } as Session);
    expect(old.connectorId).toBeUndefined();
    expect("connectorId" in old).toBe(false);
    expect(withSessionDefaults({ id: "x", title: "t", model: "m", connectorId: 5 } as unknown as Session).connectorId).toBeUndefined();
    expect(withSessionDefaults({ id: "x", title: "t", model: "m", connectorId: "c-1" } as Session).connectorId).toBe("c-1");
  });

  it("keeps the parent a session is nested under", () => {
    expect(withSessionDefaults({ id: "x", title: "t", model: "m", parentId: "p" } as Session).parentId).toBe("p");
  });

  it("gives an old session no threads, title hint or moved-in plan", () => {
    const s = withSessionDefaults({ id: "x", title: "t", model: "m" } as Session);
    expect(s.threads).toEqual([]);
    expect(s.titleHint).toBeNull();
    expect(s.planMovedIn).toBe(false);
    const bad = withSessionDefaults({ id: "x", title: "t", model: "m", threads: 3, titleHint: 4, planMovedIn: "yes" } as unknown as Session);
    expect(bad.threads).toEqual([]);
    expect(bad.titleHint).toBeNull();
    expect(bad.planMovedIn).toBe(false);
  });

  it("keeps threads, title hint and moved-in plan", () => {
    const threads = [{ sessionId: "c", summary: "Adds a thing", anchor: "call1" }];
    const s = withSessionDefaults({ id: "x", title: "t", model: "m", threads, titleHint: "Adds a thing", planMovedIn: true } as Session);
    expect(s.threads).toEqual(threads);
    expect(s.titleHint).toBe("Adds a thing");
    expect(s.planMovedIn).toBe(true);
  });

  describe("queue", () => {
    const item = (n: number, extra: object = {}) => ({
      id: `q${n}`,
      text: `message ${n}`,
      options: { connectorId: "c", model: "m", toolsOn: true, thinkOn: false, planning: true },
      images: [{ id: "i1", mediaType: "image/png" }],
      replyTo: "an earlier answer",
      queuedAt: 100 + n,
      ...extra,
    });
    const load = (extra: object) => withSessionDefaults({ id: "x", title: "t", model: "m", ...extra } as unknown as Session);

    it("gives an old session an empty queue that is not paused", () => {
      const s = load({});
      expect(s.queue).toEqual([]);
      expect(s.queuePaused).toBe(false);
    });

    it("keeps a saved queue in order, with its options, images and reply, and the pause", () => {
      const s = load({ queue: [item(1), item(2)], queuePaused: true });
      expect(s.queue).toEqual([item(1), item(2)]);
      expect(s.queuePaused).toBe(true);
    });

    it("reads a queue or pause of the wrong type as none", () => {
      const s = load({ queue: "nope", queuePaused: "yes" });
      expect(s.queue).toEqual([]);
      expect(s.queuePaused).toBe(false);
    });

    it("drops an item with no id, blank text or no model, and keeps the rest", () => {
      const s = load({
        queue: [item(1, { id: "" }), item(2, { text: "   " }), item(3, { options: { toolsOn: true } }), null, 5, item(4)],
      });
      expect(s.queue?.map((q) => q.id)).toEqual(["q4"]);
    });

    it("keeps at most 10 items, the first ones", () => {
      const s = load({ queue: Array.from({ length: 14 }, (_, i) => item(i + 1)) });
      expect(s.queue).toHaveLength(10);
      expect(s.queue?.map((q) => q.id)).toEqual(Array.from({ length: 10 }, (_, i) => `q${i + 1}`));
    });

    it("reads switches that are not true or false as off, and leaves out an empty image list and a missing connection", () => {
      const s = load({ queue: [item(1, { options: { model: "m", toolsOn: "yes" }, images: [], replyTo: "" })] });
      expect(s.queue?.[0]).toEqual({ id: "q1", text: "message 1", options: { model: "m", toolsOn: false, thinkOn: false }, queuedAt: 101 });
    });

    it("loading a loaded session again changes nothing", () => {
      const once = load({ queue: [item(1), item(2)], queuePaused: true });
      expect(withSessionDefaults(once)).toEqual(once);
    });
  });

  it("closes a tool call that never got a result when a session loads", () => {
    const raw = {
      id: "x",
      title: "t",
      model: "m",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "run_command", arguments: "{}" }] },
      ],
    } as unknown as Session;
    const s = withSessionDefaults(raw);
    expect(s.messages).toHaveLength(3);
    expect(s.messages[2]).toMatchObject({ role: "tool", toolCallId: "a", stats: { ms: 0, tokens: 0 } });
    expect(s.messages[2].content).toMatch(/did not run/);
    // Loading a repaired session again changes nothing.
    expect(withSessionDefaults(s).messages).toEqual(s.messages);
  });
});
