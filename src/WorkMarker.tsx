import { alpha, Button } from "@mui/material";

// A small line above the message box: how many sets of unfinished work this
// project has. Opens the work pane. Hidden when there is none.
export default function WorkMarker({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <Button
      size="small"
      color="inherit"
      onClick={onOpen}
      data-work-marker
      sx={(t) => ({
        mb: 0.5,
        textTransform: "none",
        alignSelf: "flex-start",
        // Translucent: the chat shows through, but the text stays easy to read.
        bgcolor: alpha(t.palette.text.primary, 0.12),
        "&:hover": { bgcolor: alpha(t.palette.text.primary, 0.2) },
      })}
    >
      {`${count} WIP`}
    </Button>
  );
}
