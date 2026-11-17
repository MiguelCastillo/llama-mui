import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import { sendCommand } from "./api";

export const takeOverQuestion = (port: number) =>
  `End the run on port ${port} and continue here? The reply or step in progress there is stopped.`;

// Asks first, then sends the takeover command. Answers null when it went ahead
// or the user said no, or a plain message when the server refused.
export async function takeOver(
  id: string,
  port: number,
  ask: (question: string) => boolean = (q) => window.confirm(q),
  send: (id: string, name: string) => Promise<unknown> = sendCommand,
): Promise<string | null> {
  if (!ask(takeOverQuestion(port))) return null;
  try {
    await send(id, "takeover");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Could not take over.";
  }
}

// The one line shown while another server holds the floor of the open session
// (a run is going there). Nothing at all when `port` is null: no one holds it,
// or this server does. Sending, Resend and Continue are off meanwhile (Chat).
// Take over ends that run; the session then shows as interrupted.
// `inPlan`: shown at the bottom of the plan card, so it sits where it is
// drawn; otherwise it floats at the top of the chat while you scroll.
export default function HeldElsewhereLine({
  port,
  sessionId,
  inPlan = false,
  canTakeOver = false,
}: {
  port: number | null | undefined;
  sessionId?: string;
  inPlan?: boolean;
  // True only when the server lists takeOver; without it no button is drawn.
  canTakeOver?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (port == null) return null;
  return (
    <Alert
      severity={error ? "error" : "info"}
      data-held-elsewhere
      sx={inPlan ? undefined : { position: "sticky", top: 0, zIndex: 1 }}
      action={
        sessionId && canTakeOver ? (
          <Button
            color="inherit"
            size="small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(await takeOver(sessionId, port));
              setBusy(false);
            }}
          >
            Take over
          </Button>
        ) : undefined
      }
    >
      Running on port {port}. Sending, Resend and Continue are off here until that run ends.
      {error ? ` Could not take over: ${error}` : ""}
    </Alert>
  );
}
