import { Typography } from "@mui/material";
import type { Approval } from "./api";

// Whether the prompt offers "Approve all commands in this session". The server
// says a command is in the dangerous-commands list by sending `dangerous`; the
// page doesn't look at the command itself. With the list, it is one time only.
export function offersSessionWide(approval: Approval): boolean {
  return approval.type === "command" && !approval.dangerous?.length;
}

// The reason a command always asks, as the server sent it. Draws nothing when
// the server sent no entries.
export default function DangerousNote({ approval }: { approval: Approval }) {
  if (approval.type !== "command" || !approval.dangerous?.length) return null;
  return (
    <Typography variant="body2" color="warning.main" component="div" role="note" sx={{ mb: 0.5, overflowWrap: "anywhere" }}>
      On your list of dangerous commands: {approval.dangerous.map((d) => `${d.label} (${d.description})`).join(" ")}
      {" "}It asks every time, even when the session approves all commands.
    </Typography>
  );
}
