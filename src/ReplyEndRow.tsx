import { Button, Stack, Tooltip, Typography } from "@mui/material";
import { failureLine, INTERRUPTED } from "./agent/helpers";
import { endButton, type EndKind } from "./runEnd";
import { StatusIcon } from "./StatusMark";

// The line under a reply that failed or was cut short, with its button.
// A stop you chose is quiet text with no red mark and no button;
// a restart or take-over offers Continue; any other failure offers Resend.
export default function ReplyEndRow({
  failed,
  endedBy,
  connectorName,
  isUser,
  onResend,
  onContinue,
  disabled,
}: {
  failed?: string | null;
  endedBy?: EndKind | null;
  connectorName?: string;
  isUser?: boolean;
  onResend?: () => void;
  onContinue?: () => void;
  disabled?: boolean;
}) {
  if (!failed && !endedBy) return null;
  const quiet = endedBy === "stopped";
  const label = endedBy ? endButton(endedBy) : "Resend";
  const click = endedBy ? onContinue : onResend;
  return (
    <Stack spacing={0.5} sx={{ alignItems: isUser ? "flex-end" : "flex-start", mt: 0.5, flexShrink: 0 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        {!quiet && <StatusIcon kind="failed" fontSize="small" />}
        {/* The raw error is for debugging, so it waits on hover. */}
        <Tooltip title={endedBy || !failed || failed === INTERRUPTED ? "" : failed}>
          <Typography variant="caption" color={quiet ? "text.secondary" : "error.main"}>
            {failureLine(failed ?? "", connectorName, endedBy)}
          </Typography>
        </Tooltip>
        {label && click && (
          <Button size="small" color="error" onClick={click} disabled={disabled}>
            {label}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
