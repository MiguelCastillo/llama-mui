// A plan the tool refused (a step too long, a summary too long, too many
// steps: see server/plan.ts). The refusal goes to the model, which usually
// fixes the call and tries again; if it doesn't (small models often stop), the
// reply ends with the call's red mark inside a closed steps row, or with no
// trace at all when Show steps is off, and the chat looks like it just stopped.
// So a reply whose last update_plan call was refused says so under itself.
// Pure: no React, no I/O.

import type { ChatMessage } from "./api.ts";

// The tool's own message for the reply's last update_plan call when that call
// was refused, else null. A later call that worked makes it null: the plan was
// saved after all. `resultOf` gives a call's result text, once it has one.
export function refusedPlan(parts: ChatMessage[], resultOf: (callId: string) => string | undefined): string | null {
  let lastId: string | undefined;
  for (const m of parts) {
    if (m.role !== "assistant") continue;
    for (const c of m.toolCalls ?? []) if (c.name === "update_plan") lastId = c.id;
  }
  if (!lastId) return null;
  const result = resultOf(lastId);
  if (!result?.startsWith("Error:")) return null;
  return result.slice("Error:".length).trim() || "the plan was refused";
}
