// Todos in the session: what the model's add_todo and complete_todo calls
// change. The server checked the call and answered (server/todos.ts); chat
// applies it here and saves it with the session, like update_plan's plan.

import type { Todo, ToolCall } from "../api";

export const openTodos = (todos: Todo[]) => todos.filter((t) => t.status === "open");

// The todos after a call the server accepted; the same list for any other tool.
export function applyTodoCall(todos: Todo[], call: ToolCall, id: string, now: number): Todo[] {
  let args: any;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return todos;
  }
  if (call.name === "add_todo") {
    const summary = String(args.summary ?? "").trim().replace(/\s+/g, " ");
    if (!summary) return todos;
    const description = typeof args.description === "string" ? args.description.trim() : "";
    const context = typeof args.context === "string" ? args.context.trim() : "";
    return [...todos, { id, summary, description, context, status: "open", createdAt: now }];
  }
  if (call.name === "complete_todo") {
    return todos.map((t) => (t.id === args.id && t.status === "open" ? { ...t, status: "done" } : t));
  }
  return todos;
}

// Todos from a saved session, which may lack the field or hold odd entries.
export function readTodos(saved: unknown): Todo[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((t) => typeof t?.id === "string" && typeof t?.summary === "string")
    .map((t) => ({
      id: t.id,
      summary: t.summary,
      description: typeof t.description === "string" ? t.description : "",
      context: typeof t.context === "string" ? t.context : "",
      status: t.status === "done" ? "done" : "open",
      createdAt: Number(t.createdAt) || 0,
    }));
}
