import type { Session } from "./api";
import { readTodos } from "./agent/todos";
import { closeOpenToolCalls } from "./closeOpenToolCalls";

// A session as chat opens it, with a default for every field it reads: shared
// or imported session.json files may lack some, and chat showed a blank page.
export function withSessionDefaults(s: Session): Session {
  return {
    ...s,
    messages: Array.isArray(s.messages) ? closeOpenToolCalls(s.messages) : [],
    contextStart: typeof s.contextStart === "number" ? s.contextStart : 0,
    attachments: Array.isArray(s.attachments) ? s.attachments : [],
    usage: s.usage ?? null,
    failed: s.failed ?? null,
    plan: Array.isArray(s.plan) ? s.plan : null,
    planSummary: typeof s.planSummary === "string" ? s.planSummary : null,
    pastPlans: Array.isArray(s.pastPlans) ? s.pastPlans : [],
    todos: readTodos(s.todos),
    parentId: typeof s.parentId === "string" ? s.parentId : null,
  };
}
