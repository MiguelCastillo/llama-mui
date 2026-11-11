import { useState } from "react";
import { IconButton, ListItem, ListItemText, Popover, Switch, Tooltip, Typography } from "@mui/material";
import TaskAltOutlinedIcon from "@mui/icons-material/TaskAltOutlined";
import type { AutoApprove, AutoKind } from "./api";

// What can be approved for the rest of the session (see autoApprove.ts).
const APPROVALS: { kind: AutoKind; label: string; text: string }[] = [
  {
    kind: "changes",
    label: "Approve all file changes",
    text: "Every file the model creates, replaces or edits is approved without asking. Each diff still shows in the chat.",
  },
  {
    kind: "commands",
    label: "Approve all commands",
    text: "Every command the model runs, git or not, is approved without asking. They run as you, with your network access and credentials.",
  },
];

// In the message box's bottom row, only while a switch is on: a prompt's
// "Approve all ... in this session" turns them on, and this is where they are
// turned off again (also while a run goes, which is when it is wanted). Removing
// a worktree always asks, and so do paths outside the chat's folders.
export default function ApprovalsMarker({
  autoApprove,
  onChange,
}: {
  autoApprove: AutoApprove;
  onChange: (kind: AutoKind, on: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const on = APPROVALS.filter((a) => autoApprove[a.kind]);
  if (on.length === 0 && !anchor) return null;
  return (
    <>
      <Tooltip title={`Auto-approving for this session: ${on.map((a) => a.kind).join(" and ")}`}>
        <IconButton size="small" aria-label="Auto-approve is on" onClick={(e) => setAnchor(e.currentTarget)} sx={{ color: "warning.main" }}>
          <TaskAltOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        slotProps={{ paper: { sx: { py: 1, width: "26rem", maxWidth: "calc(100vw - 2rem)" } } }}
      >
        <Typography variant="caption" color="text.secondary" component="div" sx={{ px: 2 }}>
          For this session only. A new session asks again.
        </Typography>
        {APPROVALS.map((r) => (
          <ListItem
            key={r.kind}
            secondaryAction={
              <Switch
                edge="end"
                checked={autoApprove[r.kind] === true}
                onChange={(e) => onChange(r.kind, e.target.checked)}
                slotProps={{ input: { "aria-label": r.label } }}
              />
            }
          >
            <ListItemText primary={r.label} secondary={r.text} sx={{ pr: 6 }} />
          </ListItem>
        ))}
      </Popover>
    </>
  );
}
