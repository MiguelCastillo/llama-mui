import { useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
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
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import { PlayCircleOutlined, StopCircleOutlined } from "@mui/icons-material";
import {
  type Connector,
  type Model,
  type ModelSettings,
  type SearchResult,
  getConnectors,
  getModelSettings,
  listModelsAdmin,
  searchModels,
  downloadModel,
  updateModelSettings,
  loadModel,
  unloadModel,
  deleteModel,
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
  // Track which models are being loaded/unloaded
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  // Model to delete (null when no dialog open)
  const [deleting, setDeleting] = useState<string | null>(null);
  // Search results
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    getModelSettings()
      .then(setSettings)
      .catch((e) => setError(e.message));
    getConnectors()
      .then((l) => {
        const active = l.connectors.find((c) => c.id === l.activeId) ?? null;
        setConnector(active);
        if (active) return listModelsAdmin(active.id).then(setModels);
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

  // Loads or unloads a model, then lists the models again so each status is
  // the server's, not a guess. The server does it in the background: the
  // list right after an unload still said "loaded", so ask again each second
  // until it's done, for up to two minutes (a big model takes a while to load).
  const setLoaded = async (id: string, load: boolean) => {
    if (!connector) return;
    setLoading((s) => ({ ...s, [id]: true }));
    try {
      await (load ? loadModel : unloadModel)(connector.id, id);
      const want = load ? "loaded" : "unloaded";
      for (let i = 0; i < 120; i++) {
        const list = await listModelsAdmin(connector.id);
        setModels(list);
        if (list.find((m) => m.id === id)?.status === want) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading((s) => ({ ...s, [id]: false }));
    }
  };

  const handleDelete = async (id: string) => {
    setLoading((s) => ({ ...s, [id]: true }));
    try {
      const connectors = await getConnectors();
      if (!connectors.activeId) throw new Error("No active connector");
      await deleteModel(connectors.activeId, id);
      setModels((m) => (m ? m.filter((x) => x.id !== id) : null));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading((s) => ({ ...s, [id]: false }));
    }
  };

  const handleSearch = async (query: string) => {
    setSearching(true);
    setSearchError(null);
    if (!query.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    try {
      const results = await searchModels(query);
      setSearchResults(results);
    } catch (e: any) {
      setSearchError(e.message);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const startDownload = async (result: SearchResult) => {
    try {
      const connectors = await getConnectors();
      if (!connectors.activeId) throw new Error("No active connector");
      const modelId = result.id;
      // Extract repo and quant from model id like "meta-llama/Llama-2-7b.Q4_K_M"
      const [repo, quant] = modelId.split(":");
      const model = quant ? `${repo}:${quant}` : repo;
      await downloadModel(connectors.activeId, model);
      // Refresh models list
      const active = connectors.connectors.find((c) => c.id === connectors.activeId);
      if (active) {
        setModels(await listModelsAdmin(active.id));
      }
    } catch (e: any) {
      setError(e.message);
    }
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
        <Stack spacing={2}>
          {/* Model list */}
          <Paper variant="outlined">
            <List disablePadding>
              {models.map((m, i) => (
                <ListItem key={m.id} divider={i < models.length - 1} sx={{ gap: 2 }}>
                  <ListItemText
                    sx={{ minWidth: 0 }}
                    primary={
                      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                        <Typography sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{m.id}</Typography>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={m.status}
                          color={m.status === "loaded" ? "success" : "default"}
                        />
                      </Stack>
                    }
                    // n/a: unloaded and started without --ctx-size, so the
                    // server doesn't say until it's loaded (see contextSize).
                    secondary={m.contextSize ? `${m.contextSize.toLocaleString()}-token context` : "Context n/a"}
                  />
                  {/* Short label so it stays on the model's line; the note below explains it. */}
                  <Tooltip title="Think before answering">
                    <FormControlLabel
                      label="Think"
                      labelPlacement="start"
                      control={
                        <Switch
                          checked={settingsFor(m.id)!.think}
                          onChange={(e) => setThink(m.id, e.target.checked)}
                          slotProps={{ input: { "aria-label": `Think before answering with ${m.id}` } }}
                        />
                      }
                      sx={{ ml: "auto", mr: 0, flexShrink: 0 }}
                    />
                  </Tooltip>
                  {/* Load/Unload buttons */}
                  <Stack direction="row" spacing={0.5} sx={{ ml: 1, flexShrink: 0 }}>
                    {m.status === "unloaded" && (
                      <Tooltip title="Load model">
                        <Button
                          size="small"
                          variant="contained"
                          color="primary"
                          onClick={() => setLoaded(m.id, true)}
                          disabled={loading[m.id]}
                          startIcon={<PlayCircleOutlined />}
                        >
                          Load
                        </Button>
                      </Tooltip>
                    )}
                    {m.status === "loaded" && (
                      <Tooltip title="Unload model">
                        <Button
                          size="small"
                          variant="contained"
                          color="error"
                          onClick={() => setLoaded(m.id, false)}
                          disabled={loading[m.id]}
                          startIcon={<StopCircleOutlined />}
                        >
                          Unload
                        </Button>
                      </Tooltip>
                    )}
                  </Stack>
                  {/* Delete button with MUI Dialog */}
                  {/* The server can only delete downloaded models, and not while loaded. */}
                  {m.canRemove && m.status !== "loaded" && (
                    <Tooltip title="Delete model">
                      <IconButton onClick={() => setDeleting(m.id)}>
                        <DeleteOutlinedIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                </ListItem>
              ))}

              {/* Delete confirmation dialog - outside the list */}
              {deleting && (
                <Dialog
                  open={!!deleting}
                  onClose={() => setDeleting(null)}
                  sx={{ maxWidth: "sm" }}
                >
                  <DialogTitle>Delete model?</DialogTitle>
                  <DialogContent>
                    <DialogContentText>
                      This removes the model from the server's cache. The model will still be available on Hugging Face and can be downloaded again.
                    </DialogContentText>
                  </DialogContent>
                  <DialogActions>
                    <Button onClick={() => setDeleting(null)}>Cancel</Button>
                    <Button
                      color="error"
                      onClick={() => handleDelete(deleting!)}
                    >
                      Delete
                    </Button>
                  </DialogActions>
                </Dialog>
              )}
            </List>
          </Paper>

          {/* Search section */}
          <Paper variant="outlined">
            <Box sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                <Typography variant="h6">Search Hugging Face</Typography>
                <TextField
                  size="small"
                  placeholder="e.g. llama-2, mistral, qwen"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  sx={{ flex: 1, minWidth: 200 }}
                />
                <Button
                  variant="contained"
                  onClick={() => handleSearch(searchQuery)}
                  disabled={searching || !searchQuery.trim()}
                >
                  {searching ? "Searching…" : "Search"}
                </Button>
              </Stack>
              {searchError && (
                <Alert severity="error" onClose={() => setSearchError(null)} sx={{ mt: 1 }}>
                  {searchError}
                </Alert>
              )}
              {searching && <CircularProgress sx={{ mt: 1 }} />}
              {searchResults && searchResults.length > 0 && (
                <Autocomplete
                  disablePortal
                  options={searchResults}
                  getOptionLabel={(option) => `${option.id}\n${option.author}`}
                  isOptionEqualToValue={(option, value) => option.id === value.id}
                  onChange={(_, value) => {
                    if (value) {
                      startDownload(value);
                    }
                  }}
                  renderInput={(params) => (
                    <TextField {...params} label="Select a model to download" />
                  )}
                  renderOption={(props, option) => (
                    <Box component="li" {...props}>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <Typography variant="body2" sx={{ fontWeight: "bold" }}>
                          {option.id}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          by {option.author}
                        </Typography>
                      </Box>
                      {option.likes !== undefined && (
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
                          {option.likes.toLocaleString()} likes
                        </Typography>
                      )}
                      {option.downloads !== undefined && (
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
                          {option.downloads.toLocaleString()} downloads
                        </Typography>
                      )}
                    </Box>
                  )}
                  sx={{ mt: 1 }}
                />
              )}
              {!searching && searchError === null && searchResults?.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Enter a model name to search for GGUF models on Hugging Face.
                </Typography>
              )}
            </Box>
          </Paper>
        </Stack>
      )}

      <Typography variant="body2" color="text.secondary">
        <b>Think</b> (before answering) lets a reasoning model (like Qwen) work through the problem first; its thoughts
        show in a collapsible panel above the reply. It helps with hard questions but is slower, and small models can
        spend minutes on simple ones. Models whose chat template has no thinking mode ignore it. With it off, small
        models usually skip the tools and answer from what they already know, so chat offers to turn it on when you
        switch Tools on.
      </Typography>
    </Stack>
  );
}
