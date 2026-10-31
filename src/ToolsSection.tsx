import { type ReactNode, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
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
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import { type ToolGroup, getConnectors, getModelSettings, getTools, listModels, setToolEnabled } from "./api";

// Models on the selected server with Think off. Without it, small models
// usually skip the tools, so the Tools page warns about them.
async function modelsNotThinking(): Promise<string[]> {
  const [{ connectors, activeId }, settings] = await Promise.all([getConnectors(), getModelSettings()]);
  if (!activeId || !connectors.some((c) => c.id === activeId)) return [];
  const models = await listModels(activeId);
  return models.map((m) => m.id).filter((id) => !(settings.models[id] ?? settings.defaults).think);
}

// Per-group icons; groups not listed here get a generic one.
const GROUP_UI: Record<string, { icon: ReactNode }> = {
  disk: { icon: <FolderOutlinedIcon /> },
  write: { icon: <EditOutlinedIcon /> },
  terminal: { icon: <TerminalOutlinedIcon /> },
  web: { icon: <PublicOutlinedIcon /> },
};

export default function ToolsSection() {
  const [state, setState] = useState<{ groups: ToolGroup[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notThinking, setNotThinking] = useState<string[]>([]);

  const reload = () =>
    getTools()
      .then(setState)
      .catch((e) => setError(e.message));

  useEffect(() => {
    reload();
    // Only a hint, so a server that's down just means no warning.
    modelsNotThinking()
      .then(setNotThinking)
      .catch(() => setNotThinking([]));
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
          Things the model can do while it answers. The model gets them only while the Tools switch in chat is on;
          it starts off, and your browser remembers where you leave it.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {notThinking.length > 0 && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" href="#/settings/models">
              Models
            </Button>
          }
        >
          Think is off for {notThinking.join(", ")}. Without it, small models usually skip the tools: instead of
          reading your files or searching the web, they answer from what they already know. Turn it on in Settings
          → Models.
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
