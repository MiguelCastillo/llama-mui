// No React in this file, so the page and the server share it.
//
// "Approve for this session": the user ticks a box on an approval prompt and
// the same kind of approval is then given without asking again, for the rest
// of that session. The flags live in the session (Session.autoApprove), so a
// reload keeps them and a new session starts without any.
//
//  - changes:  every file change (create, overwrite, edit) is approved.
//  - commands: every command is approved, git or not. It runs as the user.
//
// Removing a worktree is never approved this way, and neither is a change to
// the user's standing rules (~/.llama-mui/rules.md). What the tools check before
// they ask (the paths a chat may reach, settings.json and the keys being off
// limits) is unchanged: this only skips the question.

import type { Approval, AutoApprove, AutoKind } from "./api.ts";

export type { AutoApprove, AutoKind };

export const AUTO_KINDS = ["changes", "commands"] as const;

// Whether this session's flags approve `approval` without asking.
export function autoApproves(flags: AutoApprove | undefined, approval: Approval): boolean {
  if (!flags) return false;
  // The user's standing rules are never approved for them: they govern every later reply.
  if (approval.type === "change") return flags.changes === true && !/[\\/]\.llama-mui[\\/]rules\.md$/.test(approval.path);
  if (approval.type === "command") return flags.commands === true;
  return false;
}

// The flags after setting or clearing `kind`; a clean result has no keys.
export function withAuto(flags: AutoApprove | undefined, kind: AutoKind, on: boolean): AutoApprove {
  const next = { ...flags };
  if (on) next[kind] = true;
  else delete next[kind];
  return next;
}
