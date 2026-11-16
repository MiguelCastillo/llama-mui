import Typography from "@mui/material/Typography";
import type { ChatMessage } from "./api";

// Under a reply the app stopped in the middle of: it is kept as it stood on
// screen, and is not sent to the model again. Nothing for a complete answer.
export default function CutOffNote({ parts }: { parts: ChatMessage[] }) {
  if (!parts.some((p) => p.role === "assistant" && p.cutOff)) return null;
  return (
    <Typography variant="caption" color="text.secondary">
      Cut off when the app stopped
    </Typography>
  );
}
