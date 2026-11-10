// Look and wording shared by the step rows in a reply (the thinking and
// tool-call rows, and the summary row that holds them). Kept apart from the chat
// screen so the summary row can use them without importing it back.

// Flat, compact look shared by the tool-call and reasoning accordions: no
// fill, a hairline between rows, a short summary row.
export const flatAccordionSx = {
  bgcolor: "transparent",
  borderTop: 1,
  borderColor: "divider",
  // The reply's Stack puts a top margin on each sibling; the doubled selector
  // wins over it so the rows sit flush, divided only by the hairline.
  "&&": { mt: 0 },
  "&:before": { display: "none" },
  // The first row sits against the card's top, and needs no hairline above it:
  // the card's own border is there.
  "&:first-of-type": { borderTop: 0 },
  "& .MuiAccordionSummary-root": { minHeight: "1.75rem", px: 1, py: 0 },
  "& .MuiAccordionSummary-root.Mui-expanded": { minHeight: "1.75rem" },
  "& .MuiAccordionSummary-content": { my: 0.25 },
  "& .MuiAccordionSummary-content.Mui-expanded": { my: 0.25 },
  "& .MuiAccordionSummary-expandIconWrapper .MuiSvgIcon-root": { fontSize: "1.25rem" },
  "& .MuiAccordionDetails-root": { px: 1, pt: 0.5, pb: 1 },
} as const;

export const formatSeconds = (ms: number) => {
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`;
};
