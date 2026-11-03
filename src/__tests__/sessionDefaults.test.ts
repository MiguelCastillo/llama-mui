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
      pastPlans: [],
      todos: [],
    });
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
