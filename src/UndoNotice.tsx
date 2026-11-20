import { Box, Button, Typography } from "@mui/material";

// "Removed: <summary>" with an Undo button, shown for a few seconds after a
// Remove. It only draws; the caller owns the timer and what Undo does. While
// `busy` Undo is off; `error` is a plain message when the undo was refused.
export default function UndoNotice({
  summary,
  busy = false,
  error,
  onUndo,
}: {
  summary: string;
  busy?: boolean;
  error?: string;
  onUndo: () => void;
}) {
  return (
    <Box role="status" data-testid="undo-notice" sx={{ px: 2, py: 1, borderTop: 1, borderColor: "divider" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography sx={{ flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" }}>Removed: {summary}</Typography>
        <Button onClick={onUndo} disabled={busy} sx={{ minHeight: "2.75rem", minWidth: "4rem", flexShrink: 0 }}>
          Undo
        </Button>
      </Box>
      {error ? (
        <Typography variant="body2" color="error" role="alert">
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}
