import { useState, type ReactNode } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Stack,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { flatAccordionSx } from "./stepFormat";
import type { StepSummary } from "./stepSummary";

// The one line one round's steps (thinking and tool calls) are folded into:
// "3 steps". Closed until clicked; open, it shows the step rows (`children`).
// While the reply runs, the live line at its bottom says what it is doing; the
// reply's total time is in the footer under the reply.
export default function StepsRow({
  summary,
  children,
}: {
  summary: StepSummary;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { count } = summary;
  const label = `${count} ${count === 1 ? "step" : "steps"}`;
  return (
    <Accordion
      disableGutters
      expanded={open}
      onChange={(_, o) => setOpen(o)}
      elevation={0}
      sx={{
        ...flatAccordionSx,
        // Open, the step rows fill the width with no padding of their own; the
        // first gets a hairline under the summary (the look's own rule drops it
        // for a first row). The doubled selector wins over the look's padding.
        "&& .steps-details": {
          p: 0,
          "& > .MuiAccordion-root:first-of-type": {
            borderTop: 1,
            borderColor: "divider",
          },
        },
      }}
    >
      {/* minWidth 0 down the flex chain lets a long label (a tool name) shrink
          instead of widening the reply. */}
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        aria-label={`Steps: ${label}`}
        sx={{ "& .MuiAccordionSummary-content": { minWidth: 0 } }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", minWidth: 0 }}
        >
          <Typography
            variant="body2"
            color="text.secondary"
            noWrap
            title={label}
          >
            {label}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails className="steps-details">{children}</AccordionDetails>
    </Accordion>
  );
}
