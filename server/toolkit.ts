// Shared shape for model tools, kept apart from the registry so tool modules
// can import it without a cycle.

import type { Store } from "./store.ts";

// What a tool call runs with: the saved settings, the chat it came from, its
// working directory (a folder, or null) and the extra files and folders
// attached to it (both already resolved and checked), and the approval the
// user gave for this call, serialized, if any (see ApprovalNeeded).
export interface ToolContext {
  store: Store;
  chatId: string;
  // Where relative paths and run_command start. Null: the chat has none.
  // It's also reachable by tools, but isn't repeated in `attachments`.
  workingDir: string | null;
  attachments: string[];
  approved: string | null;
  // The session's open todos, sent by chat with each call (see server/todos.ts).
  todos: { id: string; summary: string }[];
  // The connector and model of the reply this call is part of, for a tool that
  // has to ask a model. Missing when the caller didn't say.
  connectorId?: string;
  model?: string;
}

// The folders and files the tools may reach: the working directory first,
// then the attachments, each once. Only the working directory is where
// relative paths start; everything here is just allowed (see disk.ts).
export const reachableRoots = ({ workingDir, attachments }: Pick<ToolContext, "workingDir" | "attachments">): string[] => [
  ...new Set([...(workingDir ? [workingDir] : []), ...attachments]),
];

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
  readonly target: AccessRequest;
  constructor(target: AccessRequest) {
    super(`${target.path} isn't attached to this chat`);
    this.target = target;
  }
}

// Thrown by locate_path: the model knows what the user means ("the llama-mui
// project") but not where it is. Chat asks the user to pick it; the call
// never runs on the server.
export class LocateNeeded extends Error {
  readonly request: { description: string; kind: AttachmentTarget["kind"] };
  constructor(request: { description: string; kind: AttachmentTarget["kind"] }) {
    super(`The user needs to locate ${request.description}`);
    this.request = request;
  }
}

// What a tool wants to do that the user must approve first, as they see it:
// a change to a file, a shell command, or a git worktree being removed
// (which also changes the repo's own .git). Making a worktree needs no
// approval: turning the Worktrees tools on allows it.
export type Approval =
  | {
      type: "change";
      path: string;
      action: "create" | "overwrite" | "edit";
      // Unified diff hunks, without the file header.
      diff: string;
      reason?: string;
    }
  // readOnly: the model's own claim that the command only looks (absent when it said nothing).
  | { type: "command"; command: string; cwd: string; reason?: string; readOnly?: boolean }
  | { type: "worktree"; action: "remove"; repo: string; branch: string; path: string; reason?: string }
  // inspect_page on a host other than this computer.
  | { type: "page"; url: string; host: string; reason?: string };

const REASON_MAX = 200;

// The model's own words on why a call needs approval, from a tool call's
// arguments: trimmed and clipped, or undefined when missing or blank. Callers
// add it to the Approval only when defined, so the same arguments always give
// the same Approval (requireApproval compares them serialized).
export function reasonOf(args: unknown): string | undefined {
  const raw = args && typeof args === "object" ? (args as { reason?: unknown }).reason : undefined;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  return text.length > REASON_MAX ? text.slice(0, REASON_MAX).trimEnd() : text;
}

// Thrown until the user approves. Chat runs the call again with the approval
// it showed, serialized, in ToolContext.approved.
export class ApprovalNeeded extends Error {
  readonly approval: Approval;
  constructor(approval: Approval) {
    super("This needs the user's approval");
    this.approval = approval;
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
