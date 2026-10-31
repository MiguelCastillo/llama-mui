import { type ReactNode, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import { type ToolsState, addDirectory, getDirectories, getTools, removeDirectory, setToolEnabled } from "./api";

// Per-group extras: an icon, and settings the group needs before its tools
// work. Groups not listed here get a generic icon and no extra settings.
const GROUP_UI: Record<string, { icon: ReactNode; Setup?: (p: { onChange: () => void }) => ReactNode }> = {
  disk: { icon: <FolderOutlinedIcon />, Setup: DiskFolders },
  web: { icon: <PublicOutlinedIcon /> },
};

export default function ToolsSection() {
  const [state, setState] = useState<ToolsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    getTools()
      .then(setState)
      .catch((e) => setError(e.message));

  useEffect(() => {
    reload();
  }, []);

  const toggle = (name: string, enabled: boolean) => {
    // Flip it right away; reload either confirms it or puts it back.
    setState(
      (s) =>
        s && {
          ...s,
          groups: s.groups.map((g) => ({ ...g, tools: g.tools.map((t) => (t.name === name ? { ...t, enabled } : t)) })),
        },
    );
    setToolEnabled(name, enabled)
      .catch((e) => setError(e.message))
      .finally(reload);
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">Tools</Typography>
        <Typography color="text.secondary">
          Things the model can do while it answers. The Tools switch in chat turns them all off for a conversation.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!state ? (
        <CircularProgress sx={{ alignSelf: "center" }} />
      ) : (
        state.groups.map((g) => {
          const ui = GROUP_UI[g.id];
          return (
            <Paper key={g.id} variant="outlined">
              <Stack direction="row" spacing={1.5} sx={{ p: 2, alignItems: "flex-start" }}>
                <Box sx={{ color: "text.secondary", pt: 0.25 }}>{ui?.icon ?? <BuildOutlinedIcon />}</Box>
                <Box>
                  <Typography variant="h6" sx={{ lineHeight: 1.3 }}>
                    {g.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {g.description}
                  </Typography>
                </Box>
              </Stack>

              {ui?.Setup && (
                <Box sx={{ px: 2, pb: 2 }}>
                  <ui.Setup onChange={reload} />
                </Box>
              )}
              {g.unavailable && (
                <Alert severity="info" sx={{ mx: 2, mb: 2 }}>
                  {g.unavailable}
                </Alert>
              )}

              <Divider />
              <List disablePadding>
                {g.tools.map((t, i) => (
                  <ListItem
                    key={t.name}
                    divider={i < g.tools.length - 1}
                    // Room for the switch, which is wider than ListItem leaves by default.
                    sx={{ pr: 10 }}
                    secondaryAction={
                      <Switch
                        edge="end"
                        checked={t.enabled}
                        onChange={(e) => toggle(t.name, e.target.checked)}
                        slotProps={{ input: { "aria-label": `Allow ${t.label}` } }}
                      />
                    }
                  >
                    <ListItemText
                      primary={
                        <>
                          {t.label}
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                            sx={{ ml: 1, fontFamily: "monospace" }}
                          >
                            {t.name}
                          </Typography>
                        </>
                      }
                      secondary={t.summary}
                    />
                  </ListItem>
                ))}
              </List>
            </Paper>
          );
        })
      )}
    </Stack>
  );
}

// The folders the disk tools may read.
function DiskFolders({ onChange }: { onChange: () => void }) {
  const [directories, setDirectories] = useState<string[] | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDirectories()
      .then((r) => setDirectories(r.directories))
      .catch((e) => setError(e.message));
  }, []);

  const update = (p: Promise<{ directories: string[] }>, after?: () => void) =>
    p
      .then((r) => {
        setDirectories(r.directories);
        setError(null);
        after?.();
        onChange();
      })
      .catch((e) => setError(e.message));

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Folders</Typography>
      {directories?.map((d) => (
        <Paper key={d} variant="outlined" sx={{ pl: 1.5, py: 0.5, display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="body2" sx={{ flexGrow: 1, fontFamily: "monospace", wordBreak: "break-all" }}>
            {d}
          </Typography>
          <Tooltip title="Remove">
            <IconButton size="small" onClick={() => update(removeDirectory(d))}>
              <DeleteOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Paper>
      ))}
      <Stack
        component="form"
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", pt: 0.5 }}
        onSubmit={(e) => {
          e.preventDefault();
          update(addDirectory(path), () => setPath(""));
        }}
      >
        <TextField
          fullWidth
          size="small"
          label="Add a folder"
          placeholder="~/Projects/notes"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          error={!!error}
          helperText={error ?? "A full path. ~ means your home folder. Subfolders are included."}
        />
        <Button type="submit" variant="outlined" startIcon={<AddIcon />} disabled={!path.trim()} sx={{ flexShrink: 0 }}>
          Add
        </Button>
      </Stack>
    </Stack>
  );
}
