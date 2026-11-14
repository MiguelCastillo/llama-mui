import { CircularProgress, Stack, Typography } from "@mui/material";
import Elapsed, { type StreamRate } from "./Elapsed";

// The one status line at the bottom of a reply while it is still running: a
// small spinner, what the model said it is doing (`text`), and the time since
// the task started (`since`). It holds nothing and opens nothing: the reply's
// history is drawn above it, in place. With `rate`, the time is followed by
// the streaming speed. Display only: the caller decides when to show it.
export default function LiveLineRow({
  text,
  since,
  rate,
}: {
  text: string;
  since: number;
  rate?: { current: StreamRate };
}) {
  return (
    // minWidth 0 down the flex chain lets a long note shrink to one line
    // instead of widening the reply.
    <Stack
      direction="row"
      spacing={1}
      aria-label={`Working: ${text}`}
      sx={{ alignItems: "center", minWidth: 0 }}
    >
      <CircularProgress size="0.875rem" sx={{ flexShrink: 0 }} />
      {/* The page's text is body1 (see AGENTS.md, Styling), so the words and the
          time are the same size; the time is only a quieter colour. */}
      <Typography variant="body1" noWrap title={text} sx={{ minWidth: 0 }}>
        {text}
      </Typography>
      <Elapsed since={since} rate={rate} variant="body1" color="text.secondary" sx={{ flexShrink: 0 }} />
    </Stack>
  );
}
