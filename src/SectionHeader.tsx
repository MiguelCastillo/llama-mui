import { alpha, Box, ListItemButton, Typography } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { SxProps, Theme } from "@mui/material";
import type { ReactNode } from "react";

// Room kept at the left of a row for the show/hide arrow. Shared by the
// section headers and the session rows, so an arrow in a header lines up with
// the arrow of the rows under it.
export const ARROW_SLOT = "1.5rem";

// The look of a section header band: a tint of the theme's colour, so it reads
// apart from the grey of a hovered or open row. One place for it; the headers
// of the sessions list (sessions, groups, work in progress) all use it.
// Every header is exactly this tall, so a header with a button in it (the
// sessions one) and one without (work in progress) draw the same band.
export const SECTION_HEADER_HEIGHT = "2.25rem";

export const SECTION_HEADER_SX: SxProps<Theme> = {
  borderRadius: 1,
  height: SECTION_HEADER_HEIGHT,
  pl: 0,
  pr: 1.5,
  display: "flex",
  alignItems: "center",
  bgcolor: (t: Theme) => alpha(t.palette.primary.main, 0.14),
  "&:hover": { bgcolor: (t: Theme) => alpha(t.palette.primary.main, 0.22) },
};

// The show/hide arrow, centred in its slot. The slot has a fixed height so the
// arrow sits in the same place no matter how tall the band is.
export function SectionArrow({ open }: { open: boolean }) {
  return (
    <Box sx={{ width: ARROW_SLOT, height: ARROW_SLOT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
    </Box>
  );
}

// One collapsible section header: the arrow, a bold title, an optional count
// and an optional slot for buttons (like the new-session one). The section's
// open state and what happens on a click are the caller's; this only draws the
// band.
export default function SectionHeader({
  title,
  open,
  onToggle,
  count,
  action,
  sx,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  count?: number;
  action?: ReactNode;
  sx?: SxProps<Theme>;
}) {
  return (
    <ListItemButton
      onClick={onToggle}
      aria-expanded={open}
      sx={{ ...SECTION_HEADER_SX, flexShrink: 0, flexGrow: 0, ...sx } as SxProps<Theme>}
    >
      <SectionArrow open={open} />
      <Typography variant="body1" noWrap sx={{ flexGrow: 1, pl: 0.5, fontWeight: 500 }}>
        {title}
      </Typography>
      {action}
      {count !== undefined && (
        <Typography variant="caption" color="text.secondary">
          {count}
        </Typography>
      )}
    </ListItemButton>
  );
}
