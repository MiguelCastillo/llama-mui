import type { Session } from "./api";
import { readTodos } from "./agent/todos";

// A session as chat opens it, with a default for every field it reads: shared
// or imported session.json files may lack some, and chat showed a blank page.
export function withSessionDefaults(s: Session): Session {
  return {
    ...s,
    messages: Array.isArray(s.messages) ? s.messages : [],
    contextStart: typeof s.contextStart === "number" ? s.contextStart : 0,
    attachments: Array.isArray(s.attachments) ? s.attachments : [],
    usage: s.usage ?? null,
    failed: s.failed ?? null,
    plan: Array.isArray(s.plan) ? s.plan : null,
    pastPlans: Array.isArray(s.pastPlans) ? s.pastPlans : [],
    todos: readTodos(s.todos),
  };
}
