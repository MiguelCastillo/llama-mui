import { type ReactNode, useEffect, useState } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  Divider,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import { type ToolGroup, getTools, setToolEnabled } from "./api";

// Per-group icons; groups not listed here get a generic one.
const GROUP_UI: Record<string, { icon: ReactNode }> = {
  disk: { icon: <FolderOutlinedIcon /> },
  write: { icon: <EditOutlinedIcon /> },
  web: { icon: <PublicOutlinedIcon /> },
};

export default function ToolsSection() {
  const [state, setState] = useState<{ groups: ToolGroup[] } | null>(null);
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
