import { describe, expect, it } from "vitest";
import type { Todo, ToolCall } from "../../api";
import { applyTodoCall, openTodos, readTodos } from "../todos";

const call = (name: string, args: object): ToolCall => ({ id: "t", name, arguments: JSON.stringify(args) });
const todo = (id: string, status: Todo["status"] = "open"): Todo => ({ id, summary: id, description: "", context: "", status, createdAt: 1 });

describe("applyTodoCall", () => {
  it("adds an open todo with the new id and time", () => {
    expect(applyTodoCall([], call("add_todo", { summary: " Change X ", description: " in my words ", context: " see src/x.ts " }), "n1", 5)).toEqual([
      { id: "n1", summary: "Change X", description: "in my words", context: "see src/x.ts", status: "open", createdAt: 5 },
    ]);
  });

  it("saves no context when the call has none", () => {
    expect(applyTodoCall([], call("add_todo", { summary: "x" }), "n1", 5)[0].context).toBe("");
  });

  it("completes only the open todo with that id", () => {
    const todos = [todo("a"), todo("b")];
    expect(applyTodoCall(todos, call("complete_todo", { id: "b" }), "n", 5).map((t) => t.status)).toEqual(["open", "done"]);
  });

  it("leaves todos alone for other tools or bad arguments", () => {
    const todos = [todo("a")];
    expect(applyTodoCall(todos, call("list_todos", {}), "n", 5)).toBe(todos);
    expect(applyTodoCall(todos, { id: "t", name: "add_todo", arguments: "{" }, "n", 5)).toBe(todos);
    expect(applyTodoCall(todos, call("add_todo", { summary: " " }), "n", 5)).toBe(todos);
  });
});

describe("openTodos", () => {
  it("drops done ones", () => {
    expect(openTodos([todo("a"), todo("b", "done")]).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("readTodos", () => {
  it("is empty without the field", () => {
    expect(readTodos(undefined)).toEqual([]);
    expect(readTodos("x")).toEqual([]);
  });

  it("fills missing fields and drops entries with no id or summary", () => {
    expect(readTodos([{ id: "a", summary: "s" }, { summary: "no id" }, null])).toEqual([
      { id: "a", summary: "s", description: "", context: "", status: "open", createdAt: 0 },
    ]);
  });
});
