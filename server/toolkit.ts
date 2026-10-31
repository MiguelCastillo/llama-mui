// Shared shape for model tools, kept apart from the registry so tool modules
// can import it without a cycle.

import type { Store } from "./store.ts";

// What a tool call runs with: the saved settings, the files and folders
// attached to the chat it came from (already resolved and checked), and the
// change the user approved for this call, if any (see ApprovalNeeded).
export interface ToolContext {
  store: Store;
  attachments: string[];
  approved: string | null;
}

export interface ToolSpec {
  name: string;
  // Settings groups tools by this; see GROUPS in tools.ts.
  group: string;
  // Shown in Settings.
  label: string;
  summary: string;
  // OpenAI-style function definition, sent to the model as-is.
  definition: { type: "function"; function: { name: string; description: string; parameters: object } };
  run: (ctx: ToolContext, args: any) => Promise<string>;
}

// Errors the model should see as the tool's result, so it can correct itself.
export class ToolError extends Error {}

// A file or folder a chat could attach; see resolveAttachment in disk.ts.
export interface AttachmentTarget {
  path: string;
  kind: "file" | "folder";
}

// Thrown when the model asks for a path outside the chat's attachments. Chat
// asks the user, and if they allow it, attaches the path and runs the call again.
export class AccessNeeded extends Error {
  constructor(readonly target: AttachmentTarget) {
    super(`${target.path} isn't attached to this chat`);
  }
}

// A change a write tool wants to make, as the user sees it before allowing it.
export interface Change {
  path: string;
  action: "create" | "overwrite" | "edit";
  // Unified diff hunks, without the file header.
  diff: string;
}

// Thrown by write tools until the user approves the change. Chat runs the call
// again with the approved diff in ToolContext.approved; the tool writes only
// if the change it would make now is still exactly that one.
export class ApprovalNeeded extends Error {
  constructor(readonly change: Change) {
    super(`The change to ${change.path} needs the user's approval`);
  }
}

export const fn = (name: string, description: string, parameters: object): ToolSpec["definition"] => ({
  type: "function",
  function: { name, description, parameters },
});
