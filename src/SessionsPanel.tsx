import {
  Box,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddCommentIcon from "@mui/icons-material/AddComment";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import type { SessionSummary } from "./api";
import { useState } from "react";

const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

// Load the saved width, or default to 260.
function loadWidth(): number {
  try {
    const v = localStorage.getItem("llama-mui:sessionsWidth");
    const n = Number(v);
    if (!Number.isNaN(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
  } catch {
    // Storage unavailable; use default.
  }
  return DEFAULT_WIDTH;
}
// Save the width, clamped to the valid range.
function saveWidth(width: number) {
  try {
    localStorage.setItem("llama-mui:sessionsWidth", String(width));
  } catch {
    // Storage unavailable; that's okay.
  }
}

// When a chat was last used: "just now", "5m ago", "3h ago", or a date.
function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// The display title for a session: userName wins, then modelName, then title.
function displayTitle(s: SessionSummary): string {
  return s.userName ?? s.modelName ?? s.title;
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
  onRename,
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
  // `name`: what the user typed, trimmed; empty goes back to the model's name.
  onRename: (id: string, name: string) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(loadWidth);
  // Which session is being renamed: { id, value }.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const saveEdit = (id: string, value: string) => {
    onRename(id, value.trim());
    setEditing(null);
  };

  const list = (
    <Box
      sx={{
        width: width,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        ...(narrow && { width: DEFAULT_WIDTH }),
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", pl: 2, pr: 1, pt: 1, pb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Sessions
        </Typography>
        <Tooltip title="New session">
          <span>
            <IconButton onClick={onNew} disabled={busy} aria-label="New session">
              <AddCommentIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      {sessions.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2 }}>
          Your sessions show up here once you send a message.
        </Typography>
      ) : (
        <List dense sx={{ overflowY: "auto", flexGrow: 1, px: 1 }}>
          {sessions.map((s) => {
            const isEditing = editing?.id === s.id;
            const title = displayTitle(s);
            return (
              <ListItem
                key={s.id}
                disablePadding
                // The action buttons show on hover, except on phones (no hover).
                sx={{
                  "& .MuiListItemSecondaryAction-root": { visibility: narrow ? "visible" : "hidden" },
                  "&:hover .MuiListItemSecondaryAction-root": { visibility: "visible" },
                }}
                secondaryAction={
                  <Box sx={{ display: "flex", gap: 0.5 }}>
                    <Tooltip title="Rename session">
                      <span>
                        <IconButton
                          edge="end"
                          size="small"
                          aria-label={`Rename ${title}`}
                          disabled={busy}
                          onClick={() => setEditing({ id: s.id, value: title })}
                        >
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Delete session">
                      <span>
                        <IconButton
                          edge="end"
                          size="small"
                          aria-label={`Delete ${title}`}
                          disabled={busy && s.id === currentId}
                          onClick={() => onDelete(s.id)}
                        >
                          <DeleteOutlinedIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                }
              >
                <ListItemButton
                  selected={s.id === currentId}
                  disabled={busy && s.id !== currentId}
                  onClick={() => onSelect(s.id)}
                  sx={{ borderRadius: 1, pr: 5 }}
                >
                  {isEditing ? (
                    <TextField
                      autoFocus
                      size="small"
                      fullWidth
                      value={editing.value}
                      placeholder={s.modelName ?? "Session name"}
                      onChange={(e) => setEditing({ id: s.id, value: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          saveEdit(s.id, (e.target as HTMLInputElement).value);
                        }
                        if (e.key === "Escape") setEditing(null);
                      }}
                      onBlur={() => saveEdit(s.id, editing.value)}
                      slotProps={{
                        input: {
                          endAdornment: (
                            // Keeps focus in the field, so its blur (which saves)
                            // doesn't fire before Cancel's click.
                            <Box
                              sx={{ display: "flex", alignItems: "center", pr: 0.5 }}
                              onMouseDown={(e) => e.preventDefault()}
                            >
                              <Tooltip title="Save">
                                <IconButton size="small" onClick={() => saveEdit(s.id, editing.value)}>
                                  ✓
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Cancel">
                                <IconButton size="small" onClick={() => setEditing(null)}>
                                  ✕
                                </IconButton>
                              </Tooltip>
                            </Box>
                          ),
                        },
                      }}
                    />
                  ) : (
                    <ListItemText
                      primary={title}
                      secondary={ago(s.updatedAt)}
                      slotProps={{ primary: { noWrap: true } }}
                    />
                  )}
                </ListItemButton>
              </ListItem>
            );
          })}
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
  return (
    <Box
      sx={{
        flexShrink: 0,
        height: "100dvh",
        borderRight: 1,
        borderColor: "divider",
        position: "relative",
        minWidth: MIN_WIDTH,
        maxWidth: MAX_WIDTH,
      }}
    >
      <Box
        sx={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 0,
          width: 6,
          cursor: "col-resize",
          zIndex: 1,
          "&:hover": { bgcolor: "action.hover" },
          userSelect: "none",
        }}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          saveWidth(DEFAULT_WIDTH);
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          let latestWidth = width;
          const onMove = (ev: MouseEvent) => {
            latestWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, ev.clientX));
            setWidth(latestWidth);
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setWidth(latestWidth);
            saveWidth(latestWidth);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      />
      {list}
    </Box>
  );
}
