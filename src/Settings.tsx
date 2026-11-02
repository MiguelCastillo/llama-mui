import { useEffect, useState } from "react";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Paper,
  Radio,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import DnsOutlinedIcon from "@mui/icons-material/DnsOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import KeyOutlinedIcon from "@mui/icons-material/KeyOutlined";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import ChatOutlinedIcon from "@mui/icons-material/ChatOutlined";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import {
  type Api,
  type Kind,
  type Connector,
  type ConnectorList,
  type TestResult,
  createConnector,
  deleteConnector,
  getConnectors,
  setActiveConnector,
  testConnector,
  updateConnector,
} from "./api";
import ChatSection from "./ChatSection";
import ModelsSection from "./ModelsSection";
import ToolsSection from "./ToolsSection";

// Settings sections, shown in the left nav. Add new ones here.
const SECTIONS = [
  { id: "connectors", label: "Connectors", icon: <DnsOutlinedIcon />, Component: ConnectorsSection },
  { id: "models", label: "Models", icon: <ViewInArOutlinedIcon />, Component: ModelsSection },
  { id: "tools", label: "Tools", icon: <BuildOutlinedIcon />, Component: ToolsSection },
  { id: "chat", label: "Chat", icon: <ChatOutlinedIcon />, Component: ChatSection },
];

export default function Settings({ section, onClose }: { section: string; onClose: () => void }) {
  // Unknown sections (old links) fall back to the first.
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <Box sx={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1 }}>
          <Tooltip title="Back to chat">
            <IconButton color="inherit" edge="start" onClick={onClose}>
              <ArrowBackIcon />
            </IconButton>
          </Tooltip>
          <Typography variant="h6">Settings</Typography>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={3}>
          <List component="nav" sx={{ width: { md: 180 }, flexShrink: 0 }}>
            {SECTIONS.map((s) => (
              <ListItemButton
                key={s.id}
                selected={s.id === current.id}
                href={`#/settings/${s.id}`}
                sx={{ borderRadius: 1 }}
              >
                <ListItemIcon>{s.icon}</ListItemIcon>
                <ListItemText primary={s.label} />
              </ListItemButton>
            ))}
          </List>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <current.Component />
          </Box>
        </Stack>
      </Container>
    </Box>
  );
}

type Status = "checking" | TestResult;

function ConnectorsSection() {
  const narrow = useMediaQuery((t) => t.breakpoints.down("sm"));
  const [list, setList] = useState<ConnectorList | null>(null);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [error, setError] = useState<string | null>(null);
  // undefined: closed, null: adding, Connector: editing.
  const [editing, setEditing] = useState<Connector | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Connector | null>(null);

  const check = (id: string) => {
    setStatuses((s) => ({ ...s, [id]: "checking" }));
    testConnector({ id })
      .catch((e): TestResult => ({ ok: false, error: String(e.message ?? e) }))
      .then((r) => setStatuses((s) => ({ ...s, [id]: r })));
  };

  const reload = () =>
    getConnectors()
      .then((l) => {
        setList(l);
        l.connectors.forEach((c) => check(c.id));
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    reload();
  }, []);

  const run = (p: Promise<unknown>) => p.then(reload).catch((e) => setError(e.message));

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: "flex-start", gap: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h5">Connectors</Typography>
          <Typography color="text.secondary">
            llama.cpp servers and Anthropic's API, which this app can talk to. Chat uses the selected one.
          </Typography>
        </Box>
        <Button
          variant="contained"
          size="small"
          startIcon={<AddIcon />}
          onClick={() => setEditing(null)}
          sx={{ flexShrink: 0, whiteSpace: "nowrap" }}
        >
          Add server
        </Button>
      </Stack>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!list ? (
        <CircularProgress sx={{ alignSelf: "center" }} />
      ) : list.connectors.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
          <Typography color="text.secondary">No servers yet. Add one to start chatting.</Typography>
        </Paper>
      ) : (
        list.connectors.map((c) => (
          <Paper
            key={c.id}
            variant="outlined"
            sx={{
              py: 1,
              pl: 0.5,
              pr: 1,
              display: "flex",
              alignItems: "center",
              gap: 1,
              borderColor: c.id === list.activeId ? "primary.main" : undefined,
            }}
          >
            <Radio
              checked={c.id === list.activeId}
              onChange={() => run(setActiveConnector(c.id))}
              slotProps={{ input: { "aria-label": `Use ${c.name}` } }}
            />
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 500 }} noWrap>
                {c.name}
              </Typography>
              {/* The URL wraps only at its own edge; the key state stays whole. */}
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ fontFamily: "monospace", overflowWrap: "anywhere", fontSize: narrow ? "0.8rem" : undefined }}
                >
                  {c.url}
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", color: "text.secondary" }}>
                  <KeyOutlinedIcon sx={{ fontSize: 14 }} color={c.hasKey ? "success" : "disabled"} />
                  <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
                    {c.hasKey ? "key saved" : "no key"}
                  </Typography>
                </Stack>
              </Stack>
              {/* On phones the status moves under the address so it has room. */}
              {narrow && (
                <Box sx={{ mt: 0.5 }}>
                  <StatusChip status={statuses[c.id]} onRetry={() => check(c.id)} />
                </Box>
              )}
            </Box>
            {!narrow && <StatusChip status={statuses[c.id]} onRetry={() => check(c.id)} />}
            <Tooltip title="Edit">
              <IconButton size="small" onClick={() => setEditing(c)}>
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton size="small" onClick={() => setDeleting(c)}>
                <DeleteOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Paper>
        ))
      )}

      {editing !== undefined && (
        <ConnectorDialog
          connector={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            reload();
          }}
        />
      )}

      <Dialog open={!!deleting} onClose={() => setDeleting(null)}>
        <DialogTitle>Delete {deleting?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>This removes the server and its saved API key from this app.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button
            color="error"
            onClick={() => {
              const id = deleting!.id;
              setDeleting(null);
              run(deleteConnector(id));
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function StatusChip({ status, onRetry }: { status?: Status; onRetry: () => void }) {
  if (!status || status === "checking") return <Chip size="small" label="Checking…" variant="outlined" />;
  if (status.ok) {
    return (
      <Chip
        size="small"
        color="success"
        variant="outlined"
        label={`Online · ${status.models} model${status.models === 1 ? "" : "s"}`}
      />
    );
  }
  return (
    <Tooltip title={`${status.error}. Click to retry.`}>
      <Chip size="small" color="error" variant="outlined" label="Offline" onClick={onRetry} />
    </Tooltip>
  );
}

function ConnectorDialog({
  connector,
  onClose,
  onSaved,
}: {
  connector: Connector | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(connector?.name ?? "");
  const [url, setUrl] = useState(connector?.url ?? "");
  const [apiKey, setApiKey] = useState("");
  // Chosen when it's added; what's on the other end doesn't change.
  const [kind, setKind] = useState<Kind>(connector?.kind ?? "llama");
  const llama = kind === "llama";
  const [api, setApi] = useState<Api>(connector?.api ?? "anthropic");
  // The saved key is never sent to the browser, so for a server that has one
  // the field starts as "keep it" rather than as an empty input.
  const [keyMode, setKeyMode] = useState<"keep" | "replace" | "remove">(connector?.hasKey ? "keep" : "replace");
  const [test, setTest] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeKeyMode = (m: typeof keyMode) => {
    setKeyMode(m);
    setApiKey("");
    setTest(null);
  };

  // What the server should do with the key: use the typed one, drop the
  // saved one, or (neither set) keep the saved one.
  const keyInput = { apiKey: keyMode === "replace" ? apiKey : undefined, clearKey: keyMode === "remove" };
  // A llama server needs its address; Anthropic's API, a key.
  const ready = llama ? !!url.trim() : keyMode === "keep" || !!apiKey.trim();

  const runTest = () => {
    setTest("checking");
    testConnector({ id: connector?.id, url, kind, ...keyInput })
      .catch((e): TestResult => ({ ok: false, error: e.message }))
      .then(setTest);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = { name, url, kind, api, ...keyInput };
      await (connector ? updateConnector(connector.id, input) : createConnector(input));
      onSaved();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{connector ? "Edit server" : "Add server"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            select
            label="Provider"
            value={kind}
            disabled={!!connector}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setTest(null);
            }}
            helperText={
              llama
                ? "A llama.cpp server: its models, which you can download, load and unload here."
                : "Anthropic's API: the Claude models your key can use."
            }
          >
            <MenuItem value="llama">llama.cpp server</MenuItem>
            <MenuItem value="anthropic">Anthropic API</MenuItem>
          </TextField>
          {llama && (
            <TextField
              label="Server URL"
              placeholder="http://192.168.1.20:8080"
              helperText="The llama.cpp server root. A trailing /v1 is fine."
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setTest(null);
              }}
              autoFocus={!connector}
              required
            />
          )}
          <TextField
            label="Name"
            placeholder={llama ? "Defaults to the server's host" : "Anthropic"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {llama && (
            <TextField
              select
              label="Chat API"
              value={api}
              onChange={(e) => {
                setApi(e.target.value as Api);
                setTest(null);
              }}
              helperText={
                api === "anthropic"
                  ? "Anthropic Messages (/v1/messages)."
                  : "OpenAI Chat Completions (/v1/chat/completions). Also shows llama.cpp's own generation speed."
              }
            >
              <MenuItem value="anthropic">Anthropic Messages</MenuItem>
              <MenuItem value="openai">OpenAI Chat Completions</MenuItem>
            </TextField>
          )}
          {keyMode === "replace" ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
              <TextField
                fullWidth
                label={connector?.hasKey ? "New API key" : "API key"}
                type="password"
                autoComplete="off"
                autoFocus={!!connector?.hasKey}
                required={!llama}
                helperText={
                  llama
                    ? "Stored only on this machine, never sent to the browser."
                    : "From console.anthropic.com. Stored only on this machine, never sent to the browser."
                }
                placeholder={connector?.hasKey || !llama ? undefined : "Optional"}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTest(null);
                }}
              />
              {connector?.hasKey && (
                <Button onClick={() => changeKeyMode("keep")} sx={{ mt: 1 }}>
                  Keep saved key
                </Button>
              )}
            </Stack>
          ) : (
            <Paper variant="outlined" sx={{ px: 2, py: 1, display: "flex", alignItems: "center", gap: 1.5 }}>
              <KeyOutlinedIcon color={keyMode === "keep" ? "success" : "disabled"} />
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2">
                  {keyMode === "keep" ? "API key saved" : "API key will be removed when you save"}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {keyMode === "keep"
                    ? "It stays on this machine and is never shown again."
                    : "The server will be called without a key."}
                </Typography>
              </Box>
              {keyMode === "keep" ? (
                <>
                  <Button size="small" onClick={() => changeKeyMode("replace")}>
                    Replace
                  </Button>
                  {/* Anthropic's API needs one. */}
                  {llama && (
                    <Button size="small" color="error" onClick={() => changeKeyMode("remove")}>
                      Remove
                    </Button>
                  )}
                </>
              ) : (
                <Button size="small" onClick={() => changeKeyMode("keep")}>
                  Undo
                </Button>
              )}
            </Paper>
          )}
          {test && test !== "checking" && (
            <Alert severity={test.ok ? "success" : "error"}>
              {test.ok ? `Connected. ${test.models} model${test.models === 1 ? "" : "s"} available.` : test.error}
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={runTest} disabled={!ready || test === "checking"} sx={{ mr: "auto" }}>
          {test === "checking" ? "Testing…" : "Test connection"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={!ready || saving}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
