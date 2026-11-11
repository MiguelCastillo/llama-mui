import type { ReactNode } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Elapsed from "./Elapsed";
import { flatAccordionSx } from "./stepFormat";

// The one line shown at the bottom of a reply while it is still running: a
// small spinner, what the model said it is doing (`text`), and the time since
// the task started (`since`). Closed until clicked; open, it shows the history
// so far (`children`). Display only: the caller decides when to show it.
export default function LiveLineRow({
  text,
  since,
  children,
}: {
  text: string;
  since: number;
  children?: ReactNode;
}) {
  return (
    <Accordion
      disableGutters
      elevation={0}
      sx={{
        ...flatAccordionSx,
        // Open, the history fills the width with no padding of its own.
        "&& .live-details": { p: 0 },
      }}
    >
      {/* minWidth 0 down the flex chain lets a long note shrink to one line
          instead of widening the reply. */}
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        aria-label={`Working: ${text}`}
        sx={{ "& .MuiAccordionSummary-content": { minWidth: 0 } }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", minWidth: 0, flex: 1 }}
        >
          <CircularProgress size="0.875rem" sx={{ flexShrink: 0 }} />
          {/* The model's note is text for you to read, so it is the normal message
              size and colour, not the small grey of a label. Only the time is small. */}
          <Typography
            variant="body1"
            noWrap
            title={text}
            sx={{ minWidth: 0, flex: 1 }}
          >
            {text}
          </Typography>
          <Elapsed
            since={since}
            variant="caption"
            color="text.secondary"
            sx={{ flexShrink: 0 }}
          />
        </Stack>
      </AccordionSummary>
      <AccordionDetails className="live-details">{children}</AccordionDetails>
    </Accordion>
  );
}
