import { Box, Button, CircularProgress, Paper, Typography } from "@mui/material";
import { threadLabel, type NoteView } from "./planThread";

// The note where a plan moved out to its own session (a thread): one line,
// "Running in a thread: <summary>" with a spinner while the thread's run is
// going, then "Done / Failed / Not finished in a thread: <summary>" and the
// thread's short report under it once the run has ended (see noteView). A click
// on the line opens the thread; the report is plain text you can select and copy.
export default function ThreadNote({
  summary,
  view,
  onOpen,
}: {
  summary: string;
  view: NoteView;
  onOpen: () => void;
}) {
  return (
    <Paper variant="outlined" sx={{ my: 1, px: 1, py: 0.5 }}>
      <Button
        size="small"
        onClick={onOpen}
        disabled={view.status === "missing"}
        sx={{ textTransform: "none", justifyContent: "flex-start", textAlign: "left", width: "100%" }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
          {view.running && <CircularProgress size="0.875rem" sx={{ flexShrink: 0 }} aria-label="Running" />}
          <span>{threadLabel(view.status, summary)}</span>
        </Box>
      </Button>
      {/* Outside the button, so the text can be selected and copied: a button's
          text can't be. */}
      {view.report && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", px: 1, pb: 0.5, textAlign: "left", userSelect: "text", whiteSpace: "pre-wrap" }}
        >
          {view.report}
        </Typography>
      )}
    </Paper>
  );
}
