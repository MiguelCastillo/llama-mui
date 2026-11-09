import { useState, type ReactNode } from "react";
import { Box, Button, CircularProgress, Collapse, Paper, Stack, Typography } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { reportParts, threadStatusWord, type NoteView } from "./planThread";
import WorktreeLines from "./WorktreeLines";
import MarkdownRenderer from "./MarkdownRenderer";
import { PanelAction } from "./Panel";
import { DoneIcon } from "./DoneMark";

// The status icons are as tall as the heading text, not MUI's fixed small size.
const statusIconSx = { fontSize: "1.25em", flexShrink: 0 } as const;

// Puts the "Follow-up:" / "Next:" label at the start of a line in bold, so the
// follow-up stands out at the regular message size.
function boldLabels(text: string): string {
  return text.replace(/^([ \t]*)(follow-up|next):/gim, "$1**$2:**");
}

// The note where a plan moved out to its own session (a thread), laid out like
// the plan card: one padded box, one column.
// - A heading row: an icon for how the thread is doing (a spinner while its run
//   is going, then a green check, red error or amber warning) and the status in
//   bold: "Running / Done / Failed / Not finished in a thread".
// - The summary under it, as regular text.
// - The thread's short report once the run has ended (see noteView), as text
//   you can select and copy. A done thread shows only its follow-up line(s); the
//   rest of the report opens with "Details". A failed or unfinished one shows
//   the whole report.
// - A row of buttons at the bottom: "Open thread" (the thread exists) and
//   "Details" (a done thread has more to show).
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
  const parts = isDone && view.report ? reportParts(view.report) : undefined;
  const hasDetails = !!parts?.body;
  // The "Needs you" line has its own Open thread button; a second one in the
  // bottom row would only repeat it.
  const needsYouLine = !!needsYou && !prompt;
  const showOpen = status !== "missing" && !needsYouLine;
  // The same size and colour as a regular message: the text goes through
  // MarkdownRenderer. No pre-wrap here, the renderer keeps line breaks itself.
  const reportStyle = {
    textAlign: "left",
    userSelect: "text",
  } as const;

  return (
    <Paper variant="outlined" sx={{ my: 1, px: 2, py: 1.5 }}>
      {/* One column, so every part sits the same distance from the next. */}
      <Stack spacing={1.5}>
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            {view.running && <CircularProgress size="1.25em" sx={{ flexShrink: 0 }} aria-label="Running" />}
            {isDone && <DoneIcon aria-label="Done" sx={{ ...statusIconSx }} />}
            {ended && status === "failed" && <ErrorOutlineIcon color="error" aria-label="Failed" sx={{ ...statusIconSx }} />}
            {ended && status === "unfinished" && (
              <WarningAmberIcon color="warning" aria-label="Not finished" sx={{ ...statusIconSx }} />
            )}
            <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700 }}>
              {threadStatusWord(status)}
            </Typography>
          </Stack>
          {summary && (
            // The colour goes in sx: this MUI version ignores color="text.secondary" on Typography.
            // A long word in the summary breaks instead of running past the padding.
            <Typography variant="body1" sx={{ mt: 0.75, textAlign: "left", color: "text.secondary", overflowWrap: "anywhere" }}>
              {summary}
            </Typography>
          )}
        </Box>
        {prompt && <Box>{prompt}</Box>}
        {needsYouLine && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="body2" color="warning.main">
              Needs you
            </Typography>
            <Button size="small" variant="outlined" color="warning" onClick={onOpen}>
              Open thread
            </Button>
          </Box>
        )}
        {parts ? (
          <>
            {parts.followUp.length > 0 && (
              <Box sx={reportStyle}>
                <MarkdownRenderer content={boldLabels(parts.followUp.join("\n"))} breaks />
              </Box>
            )}
            {hasDetails && (
              <Collapse in={showDetails} unmountOnExit>
                <Box sx={reportStyle}>
                  <MarkdownRenderer content={parts.body} breaks />
                </Box>
              </Collapse>
            )}
          </>
        ) : (
          view.report && (
            <Box sx={reportStyle}>
              <MarkdownRenderer content={boldLabels(view.report)} breaks />
            </Box>
          )
        )}
        {(showOpen || hasDetails) && (
          <Stack direction="row" spacing={1}>
            {showOpen && <PanelAction label="Open thread" variant="outlined" color="inherit" onClick={onOpen} />}
            {hasDetails && (
              <PanelAction
                label={showDetails ? "Hide details" : "Details"}
                variant="outlined"
                color="inherit"
                onClick={() => setShowDetails((v) => !v)}
              />
            )}
          </Stack>
        )}
        {!!where?.length && (
          <Box sx={{ mx: -1 }}>
            <WorktreeLines lines={where} />
          </Box>
        )}
      </Stack>
    </Paper>
  );
}
