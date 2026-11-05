import type { ReactNode } from "react";
import { Box, Button, CircularProgress, Paper, Typography } from "@mui/material";
import { threadLabel, type NoteView } from "./planThread";

// The note where a plan moved out to its own session (a thread): one line,
// "Running in a thread: <summary>" with a spinner while the thread's run is
// going, then "Done / Failed / Not finished in a thread: <summary>" and the
// thread's short report under it once the run has ended (see noteView). A click
// on the line opens the thread; the report is plain text you can select and copy.
// While the thread waits on a question the note carries it: `prompt` is the
// same prompt the thread shows, answered from here; a question the note can't
// show (`needsYou`) says "Needs you" with a button that opens the thread.
export default function ThreadNote({
  summary,
  view,
  onOpen,
  prompt,
  needsYou,
}: {
  summary: string;
  view: NoteView;
  onOpen: () => void;
  prompt?: ReactNode;
  needsYou?: boolean;
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
      {prompt && <Box sx={{ px: 1, pb: 0.5 }}>{prompt}</Box>}
      {needsYou && !prompt && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, pb: 0.5 }}>
          <Typography variant="body2" color="warning.main">
            Needs you
          </Typography>
          <Button size="small" variant="outlined" color="warning" onClick={onOpen}>
            Open thread
          </Button>
        </Box>
      )}
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
