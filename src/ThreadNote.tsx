import { useState, type ReactNode } from "react";
import { Box, Button, CircularProgress, Collapse, Paper, Typography } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { reportParts, threadLabel, type NoteView } from "./planThread";
import WorktreeLines from "./WorktreeLines";
import MarkdownRenderer from "./MarkdownRenderer";

// Puts the "Follow-up:" / "Next:" label at the start of a line in bold, so the
// follow-up stands out at the regular message size.
function boldLabels(text: string): string {
  return text.replace(/^([ \t]*)(follow-up|next):/gim, "$1**$2:**");
}

// The note where a plan moved out to its own session (a thread): one line,
// "Running in a thread: <summary>" with a spinner while the thread's run is
// going, then "Done / Failed / Not finished in a thread: <summary>" with an icon
// for how it ended (green check, red error, amber warning) and the thread's
// short report under it once the run has ended (see noteView). A click on the
// line opens the thread; the report is plain text you can select and copy.
// A done thread shows only its follow-up line(s); the rest of the report is
// behind a "Details" toggle. A failed or unfinished one shows the whole report
// and an "Open thread" button.
// While the thread waits on a question the note carries it: `prompt` is the
// same prompt the thread shows, answered from here; a question the note can't
// show (`needsYou`) says "Needs you" with a button that opens the thread.
export default function ThreadNote({
  summary,
  view,
  onOpen,
  prompt,
  needsYou,
  where,
}: {
  summary: string;
  view: NoteView;
  onOpen: () => void;
  prompt?: ReactNode;
  needsYou?: boolean;
  // Where the thread's work lives (worktreeLines); none when it used no worktree.
  where?: string[];
}) {
  const [showDetails, setShowDetails] = useState(false);
  const status = view.status;
  const ended = !view.running;
  const isDone = ended && status === "done";
  const isTrouble = ended && (status === "failed" || status === "unfinished");
  const parts = isDone && view.report ? reportParts(view.report) : undefined;
  // The same size and colour as a regular message: the text goes through
  // MarkdownRenderer. No pre-wrap here, the renderer keeps line breaks itself.
  const reportStyle = {
    px: 1,
    pb: 0.5,
    textAlign: "left",
    userSelect: "text",
  } as const;

  return (
    <Paper variant="outlined" sx={{ my: 1, px: 1, py: 0.5 }}>
      <Button
        size="small"
        onClick={onOpen}
        disabled={status === "missing"}
        sx={{
          textTransform: "none",
          justifyContent: "flex-start",
          textAlign: "left",
          width: "100%",
          fontSize: "1rem",
          lineHeight: "inherit",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
          {view.running && <CircularProgress size="0.875rem" sx={{ flexShrink: 0 }} aria-label="Running" />}
          {isDone && <CheckCircleOutlineIcon fontSize="small" color="success" aria-label="Done" sx={{ flexShrink: 0 }} />}
          {ended && status === "failed" && (
            <ErrorOutlineIcon fontSize="small" color="error" aria-label="Failed" sx={{ flexShrink: 0 }} />
          )}
          {ended && status === "unfinished" && (
            <WarningAmberIcon fontSize="small" color="warning" aria-label="Not finished" sx={{ flexShrink: 0 }} />
          )}
          <span>{threadLabel(status, summary)}</span>
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
      {parts ? (
        <>
          {parts.followUp.length > 0 && (
            <Box sx={reportStyle}>
              <MarkdownRenderer content={boldLabels(parts.followUp.join("\n"))} breaks />
            </Box>
          )}
          {parts.body && (
            <>
              <Button
                size="small"
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
                sx={{ textTransform: "none", ml: 0.5, py: 0, minWidth: 0 }}
              >
                {showDetails ? "Hide details" : "Details"}
              </Button>
              <Collapse in={showDetails} unmountOnExit>
                <Box sx={reportStyle}>
                  <MarkdownRenderer content={parts.body} breaks />
                </Box>
              </Collapse>
            </>
          )}
        </>
      ) : (
        view.report && (
          <Box sx={reportStyle}>
            <MarkdownRenderer content={boldLabels(view.report)} breaks />
          </Box>
        )
      )}
      {isTrouble && !prompt && !needsYou && (
        <Box sx={{ px: 1, pb: 0.5 }}>
          <Button size="small" variant="outlined" onClick={onOpen}>
            Open thread
          </Button>
        </Box>
      )}
      <WorktreeLines lines={where ?? []} />
    </Paper>
  );
}
