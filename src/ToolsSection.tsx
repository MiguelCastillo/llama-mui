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
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import ChecklistOutlinedIcon from "@mui/icons-material/ChecklistOutlined";
import {
  type Preferences,
  type ToolGroup,
  getPreferences,
  getTools,
  setToolEnabled,
  setToolsEnabled,
  updatePreferences,
} from "./api";

// Per-group icons; groups not listed here get a generic one.
const GROUP_UI: Record<string, { icon: ReactNode }> = {
  plan: { icon: <ChecklistOutlinedIcon /> },
  disk: { icon: <FolderOutlinedIcon /> },
  write: { icon: <EditOutlinedIcon /> },
  terminal: { icon: <TerminalOutlinedIcon /> },
  web: { icon: <PublicOutlinedIcon /> },
};

export default function ToolsSection() {
  const [state, setState] = useState<{ enabled: boolean; groups: ToolGroup[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // For the plan's own option (see FRESH_STEPS), kept with the Preferences
  // because it is a setting of how chat runs, not of one tool.
  const [prefs, setPrefs] = useState<Preferences | null>(null);

  const reload = () =>
    getTools()
      .then(setState)
      .catch((e) => setError(e.message));

  useEffect(() => {
    reload();
    getPreferences()
      .then(setPrefs)
      .catch((e) => setError(e.message));
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

  const setFresh = (value: boolean) => {
    // Flip it right away; the server's answer either confirms it or puts it back.
    setPrefs((p) => p && { ...p, freshPlanSteps: value });
    updatePreferences({ freshPlanSteps: value })
      .then(setPrefs)
      .catch((e) => {
        setError(e.message);
        getPreferences().then(setPrefs);
      });
  };

  // The plan's own option only matters while plans can be made.
  const planToolOn = !!state?.groups.some((g) => g.tools.some((t) => t.name === "update_plan" && t.enabled));

  const toggleAll = (enabled: boolean) => {
    setState((s) => s && { ...s, enabled });
    setToolsEnabled(enabled)
      .catch((e) => setError(e.message))
      .finally(reload);
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">Tools</Typography>
        <Typography color="text.secondary">
          Things the model can do while it answers. It gets every tool that is on here.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {state && (
        <Paper variant="outlined">
          <ListItem
            secondaryAction={
              <Switch
                edge="end"
                checked={state.enabled}
                onChange={(e) => toggleAll(e.target.checked)}
                slotProps={{ input: { "aria-label": "Use tools" } }}
              />
            }
          >
            <ListItemText
              primary="Use tools"
              secondary={
                state.enabled
                  ? "The model can use the tools that are on below."
                  : "Off: chat runs without tools. The choices below are kept for when you turn it back on."
              }
            />
          </ListItem>
        </Paper>
      )}

      {!state ? (
        <CircularProgress sx={{ alignSelf: "center" }} />
      ) : (
        state.groups.map((g) => {
          const ui = GROUP_UI[g.id];
          return (
            <Paper key={g.id} variant="outlined" sx={{ opacity: state.enabled ? 1 : 0.5 }}>
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
                        disabled={!state.enabled}
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
                {/* Plan behaviour, not a tool, so it sits under the plan's tool, in a
                    panel of its own that says whose option it is. */}
                {g.id === "plan" && prefs && (
                  <ListItem sx={{ display: "block", pt: 0, pb: 2 }}>
                    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "action.hover", p: 1.5 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5, letterSpacing: "0.04em" }}>
                        OPTION FOR PLAN TASKS
                      </Typography>
                      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
                        <ListItemText
                          sx={{ m: 0, opacity: planToolOn ? 1 : 0.6 }}
                          primary="Fresh context for each plan step"
                          secondary="Each step of a plan sends the model only the request, the plan, the files earlier steps changed and the step's own work, not the whole session, so long plans don't fill the context. The session keeps everything. Off sends it all, as before. Here for testing; it will become the only way."
                        />
                        <Switch
                          edge="end"
                          checked={prefs.freshPlanSteps}
                          disabled={!state.enabled || !planToolOn}
                          onChange={(e) => setFresh(e.target.checked)}
                          slotProps={{ input: { "aria-label": "Fresh context for each plan step" } }}
                        />
                      </Stack>
                    </Box>
                  </ListItem>
                )}
              </List>
            </Paper>
          );
        })
      )}
    </Stack>
  );
}
