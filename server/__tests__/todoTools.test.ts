import { describe, expect, it } from "vitest";
import { TODO_TOOLS, checkNewTodo, completeText, listText } from "../todos.ts";
import { ToolError, type ToolContext } from "../toolkit.ts";

const ctx = (todos: ToolContext["todos"]) => ({ store: {}, chatId: "c", attachments: [], approved: null, todos }) as unknown as ToolContext;
const tool = (name: string) => TODO_TOOLS.find((t) => t.name === name)!;
const open = [
  { id: "a1", summary: "Rename the sidebar" },
  { id: "b2", summary: "Try a bigger model" },
];

describe("add_todo", () => {
  it("cleans the summary and keeps the description and context", () => {
    expect(checkNewTodo({ summary: "  Change   X ", description: " I'm thinking about X ", context: " in src/x.ts " })).toEqual({
      summary: "Change X",
      description: "I'm thinking about X",
      context: "in src/x.ts",
    });
  });

  it("makes the context optional, but not a long one", () => {
    expect(checkNewTodo({ summary: "Change X" }).context).toBe("");
    expect(() => checkNewTodo({ summary: "x", context: "w".repeat(1501) })).toThrow(/about 150 words/);
  });

  it("makes the description optional", () => {
    expect(checkNewTodo({ summary: "Change X" }).description).toBe("");
  });

  it("asks for a summary, and a short one", () => {
    expect(() => checkNewTodo({})).toThrow(/summary is required/);
    expect(() => checkNewTodo({ summary: " " })).toThrow(ToolError);
    expect(() => checkNewTodo({ summary: "x".repeat(81) })).toThrow(/shorten it to under 80/);
    expect(checkNewTodo({ summary: "x".repeat(80) }).summary).toHaveLength(80);
  });

  it("answers the model in one line", async () => {
    expect(await tool("add_todo").run(ctx([]), { summary: "Change X" })).toBe("Added to the user's todos: Change X");
  });
});

describe("list_todos", () => {
  it("lists id and summary, or says there are none", async () => {
    expect(listText(open)).toBe("a1: Rename the sidebar\nb2: Try a bigger model");
    expect(await tool("list_todos").run(ctx([]), {})).toBe("There are no open todos.");
    expect(await tool("list_todos").run(ctx(open), {})).toContain("b2: Try a bigger model");
  });
});

describe("complete_todo", () => {
  it("names the todo it marked done", async () => {
    expect(completeText(open, "b2")).toBe("Marked done: Try a bigger model");
    expect(await tool("complete_todo").run(ctx(open), { id: "a1" })).toBe("Marked done: Rename the sidebar");
  });

  it("names the open ids when the id is unknown", () => {
    expect(() => completeText(open, "zzz")).toThrow(/the open ones are a1, b2\. Call list_todos/);
    expect(() => completeText([], "a1")).toThrow(/no open todos/);
  });
});
