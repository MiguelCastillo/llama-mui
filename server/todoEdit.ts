// What the page's Done, Remove and Undo buttons do to one chat's todo list. Pure:
// it takes the saved list and answers with the new one, or says what's wrong.
// The route (sessions.ts) does the locking and the writing.

export const TODO_ACTIONS = ["done", "remove", "restore"] as const;
export type TodoAction = (typeof TODO_ACTIONS)[number];

// `removed` comes with a remove: the todo as it was saved and where it stood,
// which is what a later restore needs to put it back.
export type TodoEdit =
  | { ok: true; todos: any[]; removed?: { todo: any; index: number } }
  | { ok: false; status: 400 | 404 | 409; error: string };

const describe = (todos: any[]) =>
  todos.length ? todos.map((t) => `${t?.id} ("${t?.summary}", ${t?.status})`).join(", ") : "none";

// `done` sets only that todo's status to "done"; `remove` takes it out of the
// list and says what it was; `restore` puts a removed todo (`payload.todo`) back
// at its old place (`payload.index`, kept inside the list) but only when no todo
// has its id. Every other todo, and every other field of a todo, is left as it is.
export function editTodo(saved: unknown, id: string, action: unknown, payload: { todo?: unknown; index?: unknown } = {}): TodoEdit {
  if (!TODO_ACTIONS.includes(action as TodoAction)) {
    return { ok: false, status: 400, error: `Unknown action ${JSON.stringify(action)}. Use one of: ${TODO_ACTIONS.join(", ")}.` };
  }
  const todos = Array.isArray(saved) ? saved : [];
  if (action === "restore") {
    const back = payload.todo as any;
    if (!back || typeof back !== "object" || back.id !== id || typeof back.summary !== "string" || !["open", "done"].includes(back.status)) {
      return { ok: false, status: 400, error: `To restore, send the removed todo as "todo": an object with id ${id}, a summary and a status of open or done.` };
    }
    if (todos.some((t) => t?.id === id)) {
      return { ok: false, status: 409, error: `This chat already has a todo with id ${id}, so nothing was restored. Its todos: ${describe(todos)}.` };
    }
    const at = Number.isInteger(payload.index) ? Math.min(Math.max(payload.index as number, 0), todos.length) : todos.length;
    return { ok: true, todos: [...todos.slice(0, at), back, ...todos.slice(at)] };
  }
  const index = todos.findIndex((t) => t?.id === id);
  if (index < 0) {
    return { ok: false, status: 404, error: `This chat has no todo with id ${id}. Its todos: ${describe(todos)}.` };
  }
  if (action === "remove") {
    return { ok: true, todos: todos.filter((t) => t?.id !== id), removed: { todo: todos[index], index } };
  }
  return { ok: true, todos: todos.map((t) => (t?.id === id ? { ...t, status: "done" } : t)) };
}
