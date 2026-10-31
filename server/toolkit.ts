// Shared shape for model tools, kept apart from the registry so tool modules
// can import it without a cycle.

import type { Store } from "./store.ts";

// What a tool call runs with: the saved settings, the files and folders
// attached to the chat it came from (already resolved and checked), and the
// approval the user gave for this call, serialized, if any (see ApprovalNeeded).
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

// A path the model asked for outside the chat's attachments. kind is null
// when nothing exists there: the model guessed, and the user can point it to
// the right file or folder instead.
export interface AccessRequest {
  path: string;
  kind: AttachmentTarget["kind"] | null;
}

// Thrown when the model asks for a path outside the chat's attachments. Chat
// asks the user, who can allow it (the call runs again), pick the right file
// or folder instead, or deny it.
export class AccessNeeded extends Error {
  constructor(readonly target: AccessRequest) {
    super(`${target.path} isn't attached to this chat`);
  }
}

// Thrown by locate_path: the model knows what the user means ("the llama-mui
// project") but not where it is. Chat asks the user to pick it; the call
// never runs on the server.
export class LocateNeeded extends Error {
  constructor(readonly request: { description: string; kind: AttachmentTarget["kind"] }) {
    super(`The user needs to locate ${request.description}`);
  }
}

// What a tool wants to do that the user must approve first, as they see it:
// a change to a file, or a shell command.
export type Approval =
  | {
      type: "change";
      path: string;
      action: "create" | "overwrite" | "edit";
      // Unified diff hunks, without the file header.
      diff: string;
    }
  | { type: "command"; command: string; cwd: string };

// Thrown until the user approves. Chat runs the call again with the approval
// it showed, serialized, in ToolContext.approved.
export class ApprovalNeeded extends Error {
  constructor(readonly approval: Approval) {
    super("This needs the user's approval");
  }
}

// Returns only if the user approved exactly this: if what the call would do
// now differs from what they saw (say, the file changed since the preview),
// they're asked again.
export function requireApproval(ctx: ToolContext, approval: Approval) {
  if (ctx.approved !== JSON.stringify(approval)) throw new ApprovalNeeded(approval);
}

export const fn = (name: string, description: string, parameters: object): ToolSpec["definition"] => ({
  type: "function",
  function: { name, description, parameters },
});
