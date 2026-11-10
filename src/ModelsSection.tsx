import { useEffect, useRef, useState } from "react";
import {
  Alert,
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
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import DownloadIcon from "@mui/icons-material/Download";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import AnthropicModels from "./AnthropicModels";
import DefaultButton from "./DefaultButton";
import { getSavedModelsConnectorId, pickModelsConnector, setSavedModelsConnectorId } from "./modelsConnector";
import {
  type Connector,
  type Model,
  type ModelSettings,
  type SearchResult,
  getConnectors,
  getModelSettings,
  listModelsAdmin,
  searchModels,
  setDefaultModel,
  downloadModel,
  updateModelSettings,
  loadModel,
  unloadModel,
  deleteModel,
} from "./api";

// Options for each model on the selected server. They're saved per model id,
// so they apply on any server that has the same model.
export default function ModelsSection() {
  // Every configured connection, and the one this page shows. The pick is this
  // page's own: the active connection in Settings only decides the first one.
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // undefined while loading, null when there is no connection to show.
  const connector = connectors === null ? undefined : (connectors.find((c) => c.id === selectedId) ?? null);
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
  // The search result whose download is being started, for its spinner.
  const [downloading, setDownloading] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    getModelSettings()
      .then(setSettings)
      .catch((e) => setError(e.message));
    getConnectors()
      .then((l) => {
        setConnectors(l.connectors);
        setSelectedId(pickModelsConnector(l.connectors, l.activeId, getSavedModelsConnectorId())?.id ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Lists the selected connection's models. Anthropic's API has no model
  // manager; AnthropicModels lists its own. If the pick changes before the
  // answer comes, the answer is dropped.
  const connectorId = connector?.id;
  const connectorKind = connector?.kind;
  // The connection shown right now, so an action that finishes after the pick
  // changed can tell its answer is for another connection and drop it.
  const shownId = useRef<string | undefined>(undefined);
  shownId.current = connectorId;
  useEffect(() => {
    if (!connectorId || connectorKind !== "llama") return;
    let stale = false;
    listModelsAdmin(connectorId)
      .then((list) => !stale && setModels(list))
      .catch((e) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [connectorId, connectorKind]);

  // Switches the connection this page shows: remembers it, and drops what the
  // previous one left on the page (the effect above then loads the new models).
  const selectConnector = (id: string) => {
    setSavedModelsConnectorId(id);
    setSelectedId(id);
    setModels(null);
    setSearchResults(null);
    setSearchError(null);
    setError(null);
    setDeleting(null);
    setLoading({});
  };

  // Sets or, with "", clears the model chat starts with on this server.
  const changeDefault = (id: string) => {
    if (!connector) return;
    setDefaultModel(connector, id)
      .then((saved) => setConnectors((l) => l && l.map((c) => (c.id === saved.id ? saved : c))))
      .catch((e) => setError(e.message));
  };

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
    const cid = connector.id;
    setLoading((s) => ({ ...s, [id]: true }));
    try {
      await (load ? loadModel : unloadModel)(cid, id);
      const want = load ? "loaded" : "unloaded";
      for (let i = 0; i < 120; i++) {
        const list = await listModelsAdmin(cid);
        // Stop polling if the page moved on to another connection.
        if (shownId.current !== cid) break;
        setModels(list);
        if (list.find((m) => m.id === id)?.status === want) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e: any) {
      if (shownId.current === cid) setError(e.message);
    } finally {
      setLoading((s) => ({ ...s, [id]: false }));
    }
  };

  const handleDelete = async (id: string) => {
    if (!connector) return;
    const cid = connector.id;
    setLoading((s) => ({ ...s, [id]: true }));
    try {
      await deleteModel(cid, id);
      if (shownId.current === cid) setModels((m) => (m ? m.filter((x) => x.id !== id) : null));
    } catch (e: any) {
      if (shownId.current === cid) setError(e.message);
    } finally {
      setLoading((s) => ({ ...s, [id]: false }));
    }
  };

  const handleSearch = async (query: string) => {
    if (!connector) return;
    const cid = connector.id;
    setSearching(true);
    setSearchError(null);
    if (!query.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    try {
      const results = await searchModels(cid, query);
      if (shownId.current === cid) setSearchResults(results);
    } catch (e: any) {
      if (shownId.current === cid) {
        setSearchError(e.message);
        setSearchResults([]);
      }
    } finally {
      setSearching(false);
    }
  };

  const startDownload = async (result: SearchResult) => {
    if (!connector) return;
    const cid = connector.id;
    setDownloading(result.id);
    try {
      const modelId = result.id;
      // Extract repo and quant from model id like "meta-llama/Llama-2-7b.Q4_K_M"
      const [repo, quant] = modelId.split(":");
      const model = quant ? `${repo}:${quant}` : repo;
      await downloadModel(cid, model);
      // Refresh models list
      const list = await listModelsAdmin(cid);
      if (shownId.current === cid) setModels(list);
    } catch (e: any) {
      if (shownId.current === cid) setError(e.message);
    } finally {
      setDownloading(null);
    }
  };

  // Picks which connection's models to show; it doesn't change the active one.
  const picker = connectors && connectors.length > 0 && (
    <TextField
      select
      size="small"
      label="Connection"
      value={connector?.id ?? ""}
      onChange={(e) => selectConnector(e.target.value)}
      sx={{ alignSelf: "flex-start", minWidth: "15rem" }}
    >
      {connectors.map((c) => (
        <MenuItem key={c.id} value={c.id}>
          {c.name}
        </MenuItem>
      ))}
    </TextField>
  );

  if (connector?.kind === "anthropic") {
    return (
      <Stack spacing={2}>
        {picker}
        <AnthropicModels
          connector={connector}
          think={(id) => !!settingsFor(id)?.think}
          setThink={setThink}
          changeDefault={changeDefault}
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      {picker}
      <Box>
        <Typography variant="h5">Models</Typography>
        <Typography color="text.secondary">
          Options for each model on {connector ? connector.name : "the selected connection"}. They follow the model to
          any server that has it.
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
                        {connector?.defaultModel === m.id && <Chip size="small" color="primary" label="default" />}
                      </Stack>
                    }
                    // n/a: unloaded and started without --ctx-size, so the
                    // server doesn't say until it's loaded (see contextSize).
                    secondary={
                      (m.contextSize ? `${m.contextSize.toLocaleString()}-token context` : "Context n/a") +
                      // "preset": defined in the server's preset file; "cache": downloaded.
                      (m.source ? ` · ${m.source}` : "")
                    }
                  />
                  {/* Delete, then Load / Unload, then Think. Grey like the app's other
                      action icons (color means a state, like the "loaded" chip).
                      A row without Delete keeps its space, so play/stop line up. */}
                  <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                    <DefaultButton id={m.id} current={connector?.defaultModel} change={changeDefault} />
                    {/* The server can only delete downloaded models, and not while loaded. */}
                    {m.canRemove && m.status !== "loaded" ? (
                      <Tooltip title="Delete model">
                        <IconButton
                          size="small"
                          onClick={() => setDeleting(m.id)}
                          aria-label={`Delete ${m.id}`}
                        >
                          <DeleteOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    ) : (
                      <Box sx={{ width: "2.125rem" }} />
                    )}
                    {/* The span keeps the tooltip working while the button is disabled. */}
                    {loading[m.id] ? (
                      <Box sx={{ width: "2.125rem", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <CircularProgress size="1rem" />
                      </Box>
                    ) : m.status === "loaded" ? (
                      <Tooltip title="Unload model">
                        <IconButton size="small" onClick={() => setLoaded(m.id, false)} aria-label={`Unload ${m.id}`}>
                          <StopIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    ) : m.status === "unloaded" ? (
                      <Tooltip title="Load model">
                        <IconButton size="small" onClick={() => setLoaded(m.id, true)} aria-label={`Load ${m.id}`}>
                          <PlayArrowIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    ) : (
                      <Box sx={{ width: "2.125rem" }} />
                    )}
                  </Stack>
                  {/* Short label so it stays on the model's line; the note below explains it. */}
                  <Tooltip title="Think before answering. With it off, small models usually skip the tools.">
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
                      sx={{ mr: 0, flexShrink: 0 }}
                    />
                  </Tooltip>
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

          {/* Explains the Think switch on each model's row, so it sits right under them. */}
          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">
              <b>Think</b> (before answering) lets a reasoning model (like Qwen) work through the problem before it
              writes its answer. In chat, the model's message then starts with a grey bar labelled <b>Thoughts</b>, above
              the answer. Click the bar to read what the model worked out; the time it spent thinking shows at the bar's
              right end. (The bar needs <b>Show steps</b> on in Settings → Chat.) Thinking helps with hard questions but
              is slower, and small models can spend minutes on simple ones. Models whose chat template has no thinking
              mode ignore the switch.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              <b>Think and tools:</b> with it off, small models usually skip the tools: instead of reading your files or
              searching the web, they answer from what they already know. Turn it on for a model you want to use tools.
            </Typography>
          </Stack>

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
                  onKeyDown={(e) => e.key === "Enter" && searchQuery.trim() && !searching && handleSearch(searchQuery)}
                  sx={{ flex: 1, minWidth: "12.5rem" }}
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
                <List disablePadding sx={{ mt: 1 }}>
                  {searchResults.map((r, i) => (
                    <ListItem
                      key={r.id}
                      divider={i < searchResults.length - 1}
                      disableGutters
                      secondaryAction={
                        <Tooltip title="Download to the server">
                          <span>
                            <IconButton
                              size="small"
                              edge="end"
                              disabled={downloading !== null}
                              onClick={() => startDownload(r)}
                              aria-label={`Download ${r.id}`}
                            >
                              {downloading === r.id ? <CircularProgress size="1rem" /> : <DownloadIcon fontSize="small" />}
                            </IconButton>
                          </span>
                        </Tooltip>
                      }
                    >
                      <ListItemText
                        sx={{ minWidth: 0, pr: 4 }}
                        primary={
                          <Typography sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{r.id}</Typography>
                        }
                        // Hugging Face's search leaves out author; the id starts with it ("owner/repo").
                        secondary={[
                          `by ${r.author || r.id.split("/")[0]}`,
                          r.downloads != null && `${r.downloads.toLocaleString()} downloads`,
                          r.likes != null && `${r.likes.toLocaleString()} likes`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                    </ListItem>
                  ))}
                </List>
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
    </Stack>
  );
}
