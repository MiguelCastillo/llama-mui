import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  FormControlLabel,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import {
  type Connector,
  type Model,
  type ModelSettings,
  getConnectors,
  getModelSettings,
  listModels,
  updateModelSettings,
} from "./api";

// Options for each model on the selected server. They're saved per model id,
// so they apply on any server that has the same model.
export default function ModelsSection() {
  // undefined while loading, null when no server is selected.
  const [connector, setConnector] = useState<Connector | null | undefined>(undefined);
  const [models, setModels] = useState<Model[] | null>(null);
  const [settings, setSettings] = useState<{ defaults: ModelSettings; models: Record<string, ModelSettings> } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getModelSettings()
      .then(setSettings)
      .catch((e) => setError(e.message));
    getConnectors()
      .then((l) => {
        const active = l.connectors.find((c) => c.id === l.activeId) ?? null;
        setConnector(active);
        if (active) return listModels(active.id).then(setModels);
      })
      .catch((e) => setError(e.message));
  }, []);

  const settingsFor = (id: string) => settings && { ...settings.defaults, ...settings.models[id] };

  const setThink = (id: string, think: boolean) => {
    // Flip it right away; the server's answer either confirms it or puts it back.
    setSettings((s) => s && { ...s, models: { ...s.models, [id]: { ...s.defaults, ...s.models[id], think } } });
    updateModelSettings(id, { think })
      .then((saved) => setSettings((s) => s && { ...s, models: { ...s.models, [id]: saved } }))
      .catch((e) => {
        setError(e.message);
        getModelSettings().then(setSettings);
      });
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">Models</Typography>
        <Typography color="text.secondary">
          Options for each model on {connector ? connector.name : "the selected server"}. They follow the model to any
          server that has it.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {connector === null ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
          <Typography color="text.secondary">Add a server under Connectors to see its models.</Typography>
        </Paper>
      ) : !models || !settings ? (
        !error && <CircularProgress sx={{ alignSelf: "center" }} />
      ) : (
        <Paper variant="outlined">
          <List disablePadding>
            {models.map((m, i) => (
              <ListItem key={m.id} divider={i < models.length - 1} sx={{ flexWrap: "wrap", gap: 1 }}>
                <ListItemText
                  sx={{ minWidth: 240 }}
                  primary={
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                      <Typography sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>{m.id}</Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={m.status}
                        color={m.status === "loaded" ? "success" : "default"}
                      />
                    </Stack>
                  }
                  secondary={m.contextSize ? `${m.contextSize.toLocaleString()}-token context` : undefined}
                />
                <FormControlLabel
                  label="Think before answering"
                  labelPlacement="start"
                  control={
                    <Switch checked={settingsFor(m.id)!.think} onChange={(e) => setThink(m.id, e.target.checked)} />
                  }
                  sx={{ ml: "auto" }}
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      <Typography variant="body2" color="text.secondary">
        <b>Think before answering</b> lets a reasoning model (like Qwen) work through the problem first; its thoughts
        show in a collapsible panel above the reply. It helps with hard questions but is slower, and small models can
        spend minutes on simple ones. Models whose chat template has no thinking mode ignore it. While the chat's
        Tools switch is on, thinking is always on, whatever this says: without it, small models mostly answer from
        memory instead of using their tools.
      </Typography>
    </Stack>
  );
}
