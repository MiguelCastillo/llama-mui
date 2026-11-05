import type { ReactNode } from "react";
import { Box, Typography } from "@mui/material";

// Where a thread's work lives, one line per worktree (words from worktreeLines
// in planThread.ts). Plain text you can select and copy. `actions` is the room
// for a button later (Merge to main); nothing passes one yet. Nothing shows
// without lines.
export default function WorktreeLines({ lines, actions }: { lines: string[]; actions?: ReactNode }) {
  if (lines.length === 0) return null;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, pb: 0.5, userSelect: "text" }}>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        {lines.map((l) => (
          <Typography key={l} variant="caption" color="text.secondary" sx={{ display: "block", textAlign: "left" }}>
            {l}
          </Typography>
        ))}
      </Box>
      {actions}
    </Box>
  );
}
