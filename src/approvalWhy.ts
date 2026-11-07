// No React in this file. The line an approval prompt starts with: the model's
// own reason for the request, or a plain note that it gave none, so the user
// can tell what they are being asked to approve.

export interface ApprovalWhy {
  text: string;
  // True when the model gave no reason (shown muted).
  missing: boolean;
}

export function approvalWhy(reason?: string | null): ApprovalWhy {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed ? { text: `Why: ${trimmed}`, missing: false } : { text: "No reason given", missing: true };
}
