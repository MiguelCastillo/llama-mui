// A past session as the todo list sees it: its open todos (the session
// list's `todos`, summaries only) and when it was last active, if known.
export interface TodoSession {
  id: string;
  title: string;
  todos: { id: string; summary: string }[];
  updatedAt?: number;
}

export interface TodoGroup {
  sessionId: string;
  title: string;
  todos: { id: string; summary: string }[];
  updatedAt?: number;
}

// The message a todo sends: its summary, then the description (the user's
// words) and the context (the model's notes from when it was added), each
// after a blank line when there is one.
export const todoText = (summary: string, description = "", context = "") =>
  [
    `Let's work on this todo: ${summary}`,
    description.trim(),
    context.trim() && `Context from when this todo was added:\n${context.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");

// Open todos by session, newest session first (the given order when there is
// no time). Sessions with none are left out.
export function todoGroups(sessions: TodoSession[]): TodoGroup[] {
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (b.s.updatedAt ?? 0) - (a.s.updatedAt ?? 0) || a.i - b.i)
    .filter(({ s }) => s.todos.length > 0)
    .map(({ s }) => ({ sessionId: s.id, title: s.title, todos: s.todos, updatedAt: s.updatedAt }));
}

// What a click on the empty chat starts: a starter's text, or a todo (its
// session, id and summary; the description is in the session, read once it opens).
export type Start = { text: string } | { sessionId: string; todoId: string; summary: string };

// What to do about it: "send" the text now (after opening the todo's session
// and setting a context boundary there), or "fill" the message box instead.
export interface StartAction {
  kind: "send" | "fill";
  text: string;
  sessionId?: string;
  todoId?: string;
  boundary: boolean;
}

// A start sends at once only when a model is chosen and nothing is generating;
// otherwise it falls back to filling the message box, as clicks used to.
export function startAction(start: Start, ready: { model: boolean; busy: boolean }): StartAction {
  const send = ready.model && !ready.busy;
  if ("todoId" in start) {
    return {
      kind: send ? "send" : "fill",
      text: todoText(start.summary),
      sessionId: start.sessionId,
      todoId: start.todoId,
      boundary: send,
    };
  }
  return { kind: send ? "send" : "fill", text: start.text, boundary: false };
}

// Once the todo's session has loaded (`todos` are its own): if it didn't load,
// fill instead of sending; otherwise the text gains the todo's description and context.
export function settleStart(
  action: StartAction,
  sessionLoaded: boolean,
  todos: { id: string; summary: string; description: string; context?: string }[] = [],
): StartAction {
  if (action.kind !== "send" || !action.sessionId) return action;
  if (!sessionLoaded) return { ...action, kind: "fill", boundary: false };
  const todo = todos.find((t) => t.id === action.todoId);
  return todo ? { ...action, text: todoText(todo.summary, todo.description, todo.context) } : action;
}
