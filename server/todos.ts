// Todos: things the user wants to come back to, saved in the session (see
// Todo in src/api.ts). Like update_plan, the server only checks the call and
// answers the model; chat applies it to the session, which it saves (see
// src/agent/todos.ts). The server can't write session.json itself: chat's next
// save would overwrite it. Chat sends the session's open todos with each call
// (ToolContext.todos), so list_todos and complete_todo answer from them.

import { ToolError, type ToolContext, type ToolSpec, fn } from "./toolkit.ts";

export const MAX_SUMMARY_CHARS = 80;
// About 150 words; a longer digest is no digest.
export const MAX_CONTEXT_CHARS = 1500;

type OpenTodo = ToolContext["todos"][number];

export const todoInstructions =
  "When the user asks you to add, note or park something for later, call add_todo and say so in one line. " +
  "Write the summary yourself, under 80 characters; keep the user's own words in the description. " +
  "Also write the context: your own notes, about 150 words at most, of what a new thread will need from this " +
  "conversation (relevant files and paths, decisions, constraints, what was tried, what is unclear), since that " +
  "thread starts without it; leave it empty only if the todo has nothing to do with what was discussed. " +
  "Todos are not the steps of the work being done now: those are update_plan. " +
  "When the user asks what is on their list, call list_todos; when one is finished, complete_todo.";

// The cleaned arguments of an add_todo call, or a ToolError saying what to fix.
export function checkNewTodo(args: any): { summary: string; description: string; context: string } {
  const summary = typeof args?.summary === "string" ? args.summary.trim().replace(/\s+/g, " ") : "";
  if (!summary) throw new ToolError("summary is required: one line you write, under 80 characters");
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new ToolError(`summary is ${summary.length} characters; shorten it to under ${MAX_SUMMARY_CHARS} and call again`);
  }
  const description = typeof args?.description === "string" ? args.description.trim() : "";
  const context = typeof args?.context === "string" ? args.context.trim() : "";
  if (context.length > MAX_CONTEXT_CHARS) {
    throw new ToolError(`context is ${context.length} characters; keep it to about 150 words (under ${MAX_CONTEXT_CHARS} characters) and call again`);
  }
  return { summary, description, context };
}

export const listText = (open: OpenTodo[]) =>
  open.length ? open.map((t) => `${t.id}: ${t.summary}`).join("\n") : "There are no open todos.";

// What complete_todo answers, or a ToolError naming the ids that exist.
export function completeText(open: OpenTodo[], id: unknown): string {
  const todo = open.find((t) => t.id === id);
  if (todo) return `Marked done: ${todo.summary}`;
  throw new ToolError(
    open.length
      ? `no open todo has the id ${JSON.stringify(id)}; the open ones are ${open.map((t) => t.id).join(", ")}. Call list_todos to see them`
      : "there are no open todos to complete",
  );
}

const addTodo: ToolSpec = {
  name: "add_todo",
  group: "todos",
  label: "Add a todo",
  summary: "Save something the user wants to come back to, in this session.",
  definition: fn(
    "add_todo",
    "Save something the user wants to come back to later. It is listed under My Todos on the empty chat.",
    {
      type: "object",
      properties: {
        summary: { type: "string", description: `One line you write, under ${MAX_SUMMARY_CHARS} characters.` },
        description: { type: "string", description: "The detail, in the user's own words. Optional." },
        context: {
          type: "string",
          description:
            "Your own notes for the thread that will work on this later, about 150 words at most: the relevant " +
            "files and paths, decisions made, constraints, what was tried, what is unclear. Empty if the todo is " +
            "unrelated to the conversation. Strongly encouraged.",
        },
      },
      required: ["summary"],
    },
  ),
  async run(_ctx, args) {
    const { summary } = checkNewTodo(args);
    return `Added to the user's todos: ${summary}`;
  },
};

const listTodos: ToolSpec = {
  name: "list_todos",
  group: "todos",
  label: "List todos",
  summary: "List this session's open todos.",
  definition: fn("list_todos", "List this session's open todos, each as id: summary.", {
    type: "object",
    properties: {},
  }),
  async run(ctx) {
    return listText(ctx.todos);
  },
};

const completeTodo: ToolSpec = {
  name: "complete_todo",
  group: "todos",
  label: "Complete a todo",
  summary: "Mark one of this session's todos done.",
  definition: fn("complete_todo", "Mark an open todo done, by the id list_todos shows.", {
    type: "object",
    properties: { id: { type: "string", description: "The todo's id, from list_todos." } },
    required: ["id"],
  }),
  async run(ctx, args) {
    return completeText(ctx.todos, args?.id);
  },
};

export const TODO_TOOLS = [addTodo, listTodos, completeTodo];
