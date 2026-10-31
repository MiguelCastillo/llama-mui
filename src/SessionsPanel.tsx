import {
  Box,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import AddCommentIcon from "@mui/icons-material/AddComment";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import type { SessionSummary } from "./api";

const WIDTH = 260;

// When a chat was last used: "just now", "5m ago", "3h ago", or a date.
function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// The saved chats, newest first. Beside the chat on wide screens; on phones
// it slides in over it.
export default function SessionsPanel({
  sessions,
  currentId,
  open,
  narrow,
  busy,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: {
  sessions: SessionSummary[];
  currentId: string;
  open: boolean;
  narrow: boolean;
  // A reply is running: switching chats would cut it off, so only the
  // current one stays clickable.
  busy: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const list = (
    <Box sx={{ width: WIDTH, height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ display: "flex", alignItems: "center", pl: 2, pr: 1, pt: 1, pb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Chats
        </Typography>
        <Tooltip title="New chat">
          <span>
            <IconButton onClick={onNew} disabled={busy} aria-label="New chat">
              <AddCommentIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      {sessions.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2 }}>
          Your chats show up here once you send a message.
        </Typography>
      ) : (
        <List dense sx={{ overflowY: "auto", flexGrow: 1, px: 1 }}>
          {sessions.map((s) => (
            <ListItem
              key={s.id}
              disablePadding
              // The delete button shows on hover, except on phones (no hover).
              sx={{
                "& .MuiListItemSecondaryAction-root": { visibility: narrow ? "visible" : "hidden" },
                "&:hover .MuiListItemSecondaryAction-root": { visibility: "visible" },
              }}
              secondaryAction={
                <Tooltip title="Delete chat">
                  <span>
                    <IconButton
                      edge="end"
                      size="small"
                      aria-label={`Delete ${s.title}`}
                      disabled={busy && s.id === currentId}
                      onClick={() => onDelete(s.id)}
                    >
                      <DeleteOutlinedIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              }
            >
              <ListItemButton
                selected={s.id === currentId}
                disabled={busy && s.id !== currentId}
                onClick={() => onSelect(s.id)}
                sx={{ borderRadius: 1, pr: 5 }}
              >
                <ListItemText primary={s.title} secondary={ago(s.updatedAt)} slotProps={{ primary: { noWrap: true } }} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
  if (narrow) {
    return (
      <Drawer open={open} onClose={onClose}>
        {list}
      </Drawer>
    );
  }
  if (!open) return null;
  return <Box sx={{ flexShrink: 0, height: "100dvh", borderRight: 1, borderColor: "divider" }}>{list}</Box>;
}
