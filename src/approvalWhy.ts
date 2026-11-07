// No React in this file. The line an approval prompt starts with: the model's
// own reason for the request, or a plain note that it gave none, so the user
// can tell what they are being asked to approve.

export interface ApprovalWhy {
  text: string;
  // True when the model gave no reason (shown muted).
  missing: boolean;
}

// What the model said about a command: it only looks, it changes things, or
// nothing. It is the model's claim, not a check, so the label says so when absent.
export interface ReadOnlyLabel {
  text: string;
  // True when the model said nothing (shown muted).
  missing: boolean;
}

export function readOnlyLabel(readOnly?: boolean | null): ReadOnlyLabel {
  if (readOnly === true) return { text: "Looks only", missing: false };
  if (readOnly === false) return { text: "Changes things", missing: false };
  return { text: "Not stated by the model", missing: true };
}

// Whether a prompt offers "Make plan": only for a command or a file change, and
// only while the open run is a chat reply (where the model can still call
// update_plan), not a plan step and not a thread's prompt shown in a note.
export function canMakePlan(approvalType: string, runKind?: string | null): boolean {
  return (approvalType === "command" || approvalType === "change") && runKind === "turn";
}

export function approvalWhy(reason?: string | null): ApprovalWhy {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed ? { text: `Why: ${trimmed}`, missing: false } : { text: "No reason given", missing: true };
}
