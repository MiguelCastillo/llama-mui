import {
  alpha,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddCommentIcon from "@mui/icons-material/AddComment";
import CheckIcon from "@mui/icons-material/Check";
import ClearIcon from "@mui/icons-material/Clear";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DriveFileMoveOutlinedIcon from "@mui/icons-material/DriveFileMoveOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import SearchIcon from "@mui/icons-material/Search";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import type { SessionSummary } from "./api";
import { StatusIcon } from "./StatusMark";
import { buildSessionTree, deleteLockedIds, filterTree, groupNames, groupTree, type SessionNode } from "./sessionTree";
import { useMemo, useState } from "react";

const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
// How far each level of nesting moves a row to the right (MUI spacing units).
const INDENT = 1.5;
// Room kept at the left of every row for the show/hide arrow.
const ARROW_SLOT = "1.5rem";

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
  // Open the "move to group" menu for a top-level session, at its button.
  onMove: (id: string, anchor: HTMLElement) => void;
};

// One session row, then (unless hidden) its nested sessions, one level deeper.
// Works for any depth; how deep the tree goes is decided in sessionTree.ts.
function SessionRow({ node, depth, ctx }: { node: SessionNode; depth: number; ctx: RowContext }) {
  const { currentId, narrow, busy, attention, editing, setEditing, saveEdit, collapsed } = ctx;
  const s = node.session;
  const isEditing = editing?.id === s.id;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = () => setMenuAnchor(null);
  const title = displayTitle(s);
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(s.id);
  return (
    <>
      <ListItem
        disablePadding
        // The row spans the whole list, so its hover and selected background do
        // too; nesting is padding inside it. The action buttons take their own
        // room on hover (the title shortens to make it), except on phones (no
        // hover), where they always show.
        sx={{
          position: "relative",
          pl: depth * INDENT,
          pr: 0.5,
          borderRadius: 1,
          bgcolor: s.id === currentId ? "action.selected" : undefined,
          "&:hover": { bgcolor: s.id === currentId ? "action.selected" : "action.hover" },
          // A thin line down the left edge ties a nested row to its parent.
          ...(depth > 0 && {
            "&::before": {
              content: '""',
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${depth * INDENT * 0.5 - 0.25}rem`,
              borderLeft: 1,
              borderColor: "divider",
            },
          }),
          "& .row-actions": { display: narrow || menuAnchor ? "flex" : "none" },
          "&:hover .row-actions, &:focus-within .row-actions": { display: "flex" },
        }}
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
          sx={{ borderRadius: 1, pl: 0.5, py: 0.5, flex: 1, minWidth: 0, "&:hover, &.Mui-selected, &.Mui-selected:hover": { bgcolor: "transparent" } }}
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
              <ListItemText primary={title} slotProps={{ primary: { noWrap: true, variant: "body1" } }} />
              {/* A plan here is waiting on you; the open session shows its own prompt. */}
              {s.id !== currentId && attention.has(s.id) && (
                <StatusIcon
                  kind="needsYou"
                  role="img"
                  aria-label="Needs you"
                  titleAccess="Needs you"
                  sx={{ fontSize: "1rem", ml: 1, flexShrink: 0 }}
                />
              )}
            </>
          )}
        </ListItemButton>
        <Box className="row-actions" sx={{ gap: 0.5, flexShrink: 0, alignItems: "center" }}>
          <IconButton
            size="small"
            aria-label={`Actions for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menuAnchor ? true : undefined}
            onClick={(e) => setMenuAnchor(e.currentTarget)}
          >
            <MoreHorizIcon fontSize="small" />
          </IconButton>
          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
            <MenuItem
              disabled={busy}
              onClick={() => {
                closeMenu();
                ctx.onNewNested(s.id);
              }}
            >
              <ListItemIcon>
                <SubdirectoryArrowRightIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>New nested session</ListItemText>
            </MenuItem>
            {depth === 0 && (
              <MenuItem
                onClick={() => {
                  const anchor = menuAnchor;
                  closeMenu();
                  if (anchor) ctx.onMove(s.id, anchor);
                }}
              >
                <ListItemIcon>
                  <DriveFileMoveOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Move to a group</ListItemText>
              </MenuItem>
            )}
            <MenuItem
              disabled={busy}
              onClick={() => {
                closeMenu();
                setEditing({ id: s.id, value: title });
              }}
            >
              <ListItemIcon>
                <EditOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Rename</ListItemText>
            </MenuItem>
            <Divider />
            <MenuItem
              disabled={(busy && s.id === currentId) || ctx.deleteLocked.has(s.id)}
              onClick={() => {
                closeMenu();
                ctx.onDelete(s.id);
              }}
              sx={{ color: "error.main" }}
            >
              <ListItemIcon sx={{ color: "inherit" }}>
                <DeleteOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                secondary={
                  ctx.deleteLocked.has(s.id)
                    ? "Can't delete while a plan is running in this session or one nested with it"
                    : undefined
                }
                slotProps={{ secondary: { sx: { whiteSpace: "normal", maxWidth: 240 } } }}
              >
                Delete
              </ListItemText>
            </MenuItem>
          </Menu>
        </Box>
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
  onGroup,
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
  // Put a top-level session in the group named `group`, or in none (null).
  onGroup: (id: string, group: string | null) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(loadWidth);
  // Which session is being renamed: { id, value }.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  // Rows whose nested sessions are hidden. Kept here only, not saved.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => buildSessionTree(sessions), [sessions]);
  // The search box narrows the tree by title; while it has text, groups open
  // so every match shows.
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const searching = needle !== "";
  const shownTree = useMemo(
    () => (searching ? filterTree(tree, (x) => displayTitle(x).toLowerCase().includes(needle)) : tree),
    [tree, searching, needle],
  );
  const groups = useMemo(() => groupTree(shownTree), [shownTree]);
  const names = useMemo(() => groupNames(sessions), [sessions]);
  // The "move to group" menu, and the box that names a new group.
  const [moveMenu, setMoveMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [newGroupFor, setNewGroupFor] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const movingFrom = moveMenu ? (sessions.find((x) => x.id === moveMenu.id)?.group ?? null) : null;
  const submitNewGroup = () => {
    const name = newGroupName.trim();
    if (newGroupFor && name) onGroup(newGroupFor, name);
    setNewGroupFor(null);
  };

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
    onMove: (id, anchor) => setMoveMenu({ id, anchor }),
  };

  const list = (
    <Box
      sx={{
        width: width,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        // The drawer takes three quarters of the screen, so titles have room
        // beside their action buttons.
        ...(narrow && { width: "75vw" }),
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
        <>
          <TextField
            size="small"
            placeholder="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            sx={{ mx: 1, mb: 0.5 }}
            slotProps={{
              htmlInput: { "aria-label": "Search sessions" },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton size="small" aria-label="Clear search" onClick={() => setQuery("")}>
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
          <List dense sx={{ overflowY: "auto", flexGrow: 1, px: 1, display: "flex", flexDirection: "column", gap: 0.25 }}>
            {searching && groups.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>
                No sessions match.
              </Typography>
            )}
            {groups.map((g, i) => {
              const key = `group:${g.name}`;
              // The sessions in no group get a header only beside named groups.
              const titled = g.name !== null || groups.length > 1;
              const open = !titled || searching || !collapsed.has(key);
              return (
                <Box key={g.name ?? "(none)"} sx={{ display: "flex", flexDirection: "column", gap: 0.25, mt: i > 0 ? 3 : 0 }}>
                  {titled && (
                    <ListItemButton
                      onClick={() => toggleCollapsed(key)}
                      aria-expanded={open}
                      // Lined up with the rows' arrows, on a band of its own: a tint of the theme's
                      // colour, so it reads apart from the grey of a hovered or open row.
                      sx={{ borderRadius: 1, py: 0.5, pl: 0, pr: 1.5, bgcolor: (t) => alpha(t.palette.primary.main, 0.14), "&:hover": { bgcolor: (t) => alpha(t.palette.primary.main, 0.22) } }}
                    >
                      <Box sx={{ width: ARROW_SLOT, display: "flex", justifyContent: "center", flexShrink: 0 }}>
                        {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                      </Box>
                      <Typography variant="body1" noWrap sx={{ flexGrow: 1, pl: 0.5, fontWeight: 500 }}>
                        {g.name ?? "Ungrouped"}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {g.nodes.length}
                      </Typography>
                    </ListItemButton>
                  )}
                  {open && g.nodes.map((node) => <SessionRow key={node.session.id} node={node} depth={0} ctx={ctx} />)}
                </Box>
              );
            })}
          </List>
        </>
      )}
    </Box>
  );
  const groupMenus = (
    <>
      <Menu anchorEl={moveMenu?.anchor} open={moveMenu !== null} onClose={() => setMoveMenu(null)}>
        {names.map((n) => (
          <MenuItem
            key={n}
            selected={n === movingFrom}
            onClick={() => {
              if (moveMenu && n !== movingFrom) onGroup(moveMenu.id, n);
              setMoveMenu(null);
            }}
          >
            {n}
            {n === movingFrom && <CheckIcon fontSize="small" sx={{ ml: 1 }} />}
          </MenuItem>
        ))}
        {names.length > 0 && <Divider />}
        <MenuItem
          onClick={() => {
            setNewGroupFor(moveMenu?.id ?? null);
            setNewGroupName("");
            setMoveMenu(null);
          }}
        >
          New group…
        </MenuItem>
        {movingFrom !== null && (
          <MenuItem
            onClick={() => {
              if (moveMenu) onGroup(moveMenu.id, null);
              setMoveMenu(null);
            }}
          >
            Remove from group
          </MenuItem>
        )}
      </Menu>
      <Dialog open={newGroupFor !== null} onClose={() => setNewGroupFor(null)} fullWidth maxWidth="xs">
        <DialogTitle>New group</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Group name"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitNewGroup()}
            slotProps={{ htmlInput: { maxLength: 60 } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewGroupFor(null)}>Cancel</Button>
          <Button variant="contained" disabled={!newGroupName.trim()} onClick={submitNewGroup}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
  if (narrow) {
    return (
      <Drawer open={open} onClose={onClose}>
        {list}
        {groupMenus}
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
      {groupMenus}
    </Box>
  );
}
