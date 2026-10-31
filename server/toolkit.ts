// Shared shape for model tools, kept apart from the registry so tool modules
// can import it without a cycle.

import type { Store } from "./store.ts";

export interface ToolSpec {
  name: string;
  // Settings groups tools by this; see GROUPS in tools.ts.
  group: string;
  // Shown in Settings.
  label: string;
  summary: string;
  // OpenAI-style function definition, sent to the model as-is.
  definition: { type: "function"; function: { name: string; description: string; parameters: object } };
  run: (store: Store, args: any) => Promise<string>;
}

// Errors the model should see as the tool's result, so it can correct itself.
export class ToolError extends Error {}

export const fn = (name: string, description: string, parameters: object): ToolSpec["definition"] => ({
  type: "function",
  function: { name, description, parameters },
});
