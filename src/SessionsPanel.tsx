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
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import type { SessionSummary } from "./api";
import { buildSessionTree, deleteLockedIds, type SessionNode } from "./sessionTree";
import { useMemo, useState } from "react";

const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
// How far each level of nesting moves a row to the right (MUI spacing units).
const INDENT = 1.5;
// Room kept at the left of every row for the show/hide arrow.
const ARROW_SLOT = 24;

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
export function ago(t: number): string {
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

// What every row needs from the panel; passed down instead of a long list of
// props per row.
type RowContext = {
  currentId: string;
  narrow: boolean;
  busy: boolean;
  // Ids of sessions whose plan is waiting on the user (see needsYou).
  attention: ReadonlySet<string>;
  // Ids of sessions whose delete button is off: the whole family of a session
  // with a run in progress (see deleteLockedIds).
  deleteLocked: ReadonlySet<string>;
  // Which session is being renamed: { id, value }.
  editing: { id: string; value: string } | null;
  setEditing: (e: { id: string; value: string } | null) => void;
  saveEdit: (id: string, value: string) => void;
  // Ids of rows whose nested sessions are hidden.
  collapsed: ReadonlySet<string>;
  toggleCollapsed: (id: string) => void;
  onSelect: (id: string) => void;
  onNewNested: (id: string) => void;
  onDelete: (id: string) => void;
};

// One session row, then (unless hidden) its nested sessions, one level deeper.
// Works for any depth; how deep the tree goes is decided in sessionTree.ts.
function SessionRow({ node, depth, ctx }: { node: SessionNode; depth: number; ctx: RowContext }) {
  const { currentId, narrow, busy, attention, editing, setEditing, saveEdit, collapsed } = ctx;
  const s = node.session;
  const isEditing = editing?.id === s.id;
  const title = displayTitle(s);
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(s.id);
  return (
    <>
      <ListItem
        disablePadding
        // The action buttons show on hover, except on phones (no hover).
        sx={{
          ml: depth * INDENT,
          // A thin line down the left edge ties a nested row to its parent.
          ...(depth > 0 && { borderLeft: 1, borderColor: "divider" }),
          "& .MuiListItemSecondaryAction-root": { visibility: narrow ? "visible" : "hidden" },
          "&:hover .MuiListItemSecondaryAction-root": { visibility: "visible" },
        }}
        secondaryAction={
          <Box sx={{ display: "flex", gap: 0.5 }}>
            <Tooltip title="New nested session: an empty session under this one, with the same folder and model">
              <span>
                <IconButton
                  size="small"
                  aria-label={`New nested session under ${title}`}
                  disabled={busy}
                  onClick={() => ctx.onNewNested(s.id)}
                >
                  <SubdirectoryArrowRightIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Rename session">
              <span>
                <IconButton
                  size="small"
                  aria-label={`Rename ${title}`}
                  disabled={busy}
                  onClick={() => setEditing({ id: s.id, value: title })}
                >
                  <EditOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={ctx.deleteLocked.has(s.id) ? "Can't delete while a plan is running in this session or one nested with it" : "Delete session"}>
              <span>
                <IconButton
                  edge="end"
                  size="small"
                  aria-label={`Delete ${title}`}
                  disabled={(busy && s.id === currentId) || ctx.deleteLocked.has(s.id)}
                  onClick={() => ctx.onDelete(s.id)}
                >
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        }
      >
        {hasChildren ? (
          <Tooltip title={isCollapsed ? "Show nested sessions" : "Hide nested sessions"}>
            <IconButton
              size="small"
              aria-label={`${isCollapsed ? "Show" : "Hide"} nested sessions of ${title}`}
              aria-expanded={!isCollapsed}
              onClick={() => ctx.toggleCollapsed(s.id)}
              sx={{ width: ARROW_SLOT, height: ARROW_SLOT, flexShrink: 0 }}
            >
              {isCollapsed ? <ChevronRightIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        ) : (
          <Box sx={{ width: ARROW_SLOT, flexShrink: 0 }} />
        )}
        <ListItemButton
          selected={s.id === currentId}
          disabled={busy && s.id !== currentId}
          onClick={() => ctx.onSelect(s.id)}
          sx={{ borderRadius: 1, pl: 0.5, pr: 11 }}
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
            <>
              <ListItemText primary={title} secondary={ago(s.updatedAt)} slotProps={{ primary: { noWrap: true } }} />
              {/* A plan here is waiting on you; the open session shows its own prompt. */}
              {s.id !== currentId && attention.has(s.id) && (
                <Box
                  role="img"
                  aria-label="Needs you"
                  title="Needs you"
                  sx={{ width: 8, height: 8, ml: 1, borderRadius: "50%", bgcolor: "warning.main", flexShrink: 0 }}
                />
              )}
            </>
          )}
        </ListItemButton>
      </ListItem>
      {hasChildren &&
        !isCollapsed &&
        node.children.map((c) => <SessionRow key={c.session.id} node={c} depth={depth + 1} ctx={ctx} />)}
    </>
  );
}

// The saved chats, newest first, with nested sessions under their parent.
// Beside the chat on wide screens; on phones it slides in over it.
export default function SessionsPanel({
  sessions,
  currentId,
  open,
  narrow,
  busy,
  attention,
  inProgress,
  onSelect,
  onNew,
  onNewNested,
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
  // Sessions with a plan waiting on the user: they get a small dot.
  attention: ReadonlySet<string>;
  // Sessions with a run in progress: their family can't be deleted meanwhile.
  inProgress: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  // Make an empty session under `parentId`.
  onNewNested: (parentId: string) => void;
  onDelete: (id: string) => void;
  // `name`: what the user typed, trimmed; empty goes back to the model's name.
  onRename: (id: string, name: string) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(loadWidth);
  // Which session is being renamed: { id, value }.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  // Rows whose nested sessions are hidden. Kept here only, not saved.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => buildSessionTree(sessions), [sessions]);

  const saveEdit = (id: string, value: string) => {
    onRename(id, value.trim());
    setEditing(null);
  };

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Make the nested session, and show it: open the parent's nested sessions.
  const newNested = (parentId: string) => {
    setCollapsed((prev) => {
      if (!prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.delete(parentId);
      return next;
    });
    onNewNested(parentId);
  };

  const ctx: RowContext = {
    currentId,
    narrow,
    busy,
    attention,
    deleteLocked: deleteLockedIds(tree, inProgress),
    editing,
    setEditing,
    saveEdit,
    collapsed,
    toggleCollapsed,
    onSelect,
    onNewNested: newNested,
    onDelete,
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
          {tree.map((node) => (
            <SessionRow key={node.session.id} node={node} depth={0} ctx={ctx} />
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
