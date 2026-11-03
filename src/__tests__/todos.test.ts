import { describe, expect, it } from "vitest";
import { settleStart, startAction, todoGroups, todoText } from "../todos";

const t = (id: string, summary = id) => ({ id, summary });

describe("todoGroups", () => {
  it("groups todos by session, newest first", () => {
    expect(
      todoGroups([
        { id: "a", title: "Old", updatedAt: 1, todos: [t("one")] },
        { id: "b", title: "New", updatedAt: 5, todos: [t("two"), t("three")] },
      ]),
    ).toEqual([
      { sessionId: "b", title: "New", todos: [t("two"), t("three")], updatedAt: 5 },
      { sessionId: "a", title: "Old", todos: [t("one")], updatedAt: 1 },
    ]);
  });

  it("keeps the given order when there is no time", () => {
    const g = todoGroups([
      { id: "a", title: "A", todos: [t("x")] },
      { id: "b", title: "B", todos: [t("y")] },
    ]);
    expect(g.map((x) => x.sessionId)).toEqual(["a", "b"]);
  });

  it("skips sessions with no todos", () => {
    expect(todoGroups([{ id: "a", title: "A", todos: [] }])).toEqual([]);
  });
});

describe("todoText", () => {
  it("is the summary alone without a description", () => {
    expect(todoText("Rename it")).toBe("Let's work on this todo: Rename it");
    expect(todoText("Rename it", "  ")).toBe("Let's work on this todo: Rename it");
  });

  it("puts the description after a blank line", () => {
    expect(todoText("Rename it", " I want it shorter ")).toBe("Let's work on this todo: Rename it\n\nI want it shorter");
  });
});

describe("todoText with context", () => {
  it("adds all three parts", () => {
    expect(todoText("Rename it", "shorter please", "see src/SessionsPanel.tsx")).toBe(
      "Let's work on this todo: Rename it\n\nshorter please\n\nContext from when this todo was added:\nsee src/SessionsPanel.tsx",
    );
  });

  it("adds the context when there is no description", () => {
    expect(todoText("Rename it", "", "notes")).toBe("Let's work on this todo: Rename it\n\nContext from when this todo was added:\nnotes");
  });

  it("leaves it out when empty, so summary and description alone stay as before", () => {
    expect(todoText("Rename it", "shorter", " ")).toBe("Let's work on this todo: Rename it\n\nshorter");
  });
});

describe("startAction", () => {
  const ready = { model: true, busy: false };
  const todo = { sessionId: "s1", todoId: "a1", summary: "fix it" };

  it("sends a starter at once, with no boundary", () => {
    expect(startAction({ text: "Quiz me" }, ready)).toEqual({ kind: "send", text: "Quiz me", boundary: false });
  });

  it("works on a todo in its session behind a boundary", () => {
    expect(startAction(todo, ready)).toEqual({
      kind: "send",
      text: "Let's work on this todo: fix it",
      sessionId: "s1",
      todoId: "a1",
      boundary: true,
    });
  });

  it("fills instead when there is no model or it is busy", () => {
    expect(startAction({ text: "Quiz me" }, { model: false, busy: false })).toMatchObject({ kind: "fill" });
    expect(startAction(todo, { model: true, busy: true })).toEqual({
      kind: "fill",
      text: "Let's work on this todo: fix it",
      sessionId: "s1",
      todoId: "a1",
      boundary: false,
    });
  });
});

describe("settleStart", () => {
  const action = startAction({ sessionId: "s1", todoId: "a1", summary: "fix it" }, { model: true, busy: false });
  const loaded = [{ id: "a1", summary: "fix it", description: "it breaks on Safari", status: "open" as const }];

  it("adds the description from the loaded session", () => {
    expect(settleStart(action, true, loaded).text).toBe("Let's work on this todo: fix it\n\nit breaks on Safari");
  });

  it("adds the context from the loaded session", () => {
    const withContext = [{ ...loaded[0], context: "tried X" }];
    expect(settleStart(action, true, withContext).text).toBe(
      "Let's work on this todo: fix it\n\nit breaks on Safari\n\nContext from when this todo was added:\ntried X",
    );
  });

  it("sends the summary alone for a todo with no description or one that is gone", () => {
    expect(settleStart(action, true, [{ ...loaded[0], description: "" }]).text).toBe("Let's work on this todo: fix it");
    expect(settleStart(action, true, [])).toBe(action);
  });

  it("fills when the todo's session didn't load", () => {
    expect(settleStart(action, false, loaded)).toEqual({
      kind: "fill",
      text: "Let's work on this todo: fix it",
      sessionId: "s1",
      todoId: "a1",
      boundary: false,
    });
  });

  it("leaves a starter alone", () => {
    const starter = startAction({ text: "Quiz me" }, { model: true, busy: false });
    expect(settleStart(starter, false)).toBe(starter);
  });
});
