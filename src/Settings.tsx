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
  Link,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Paper,
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
import BarChartOutlinedIcon from "@mui/icons-material/BarChartOutlined";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import ChatOutlinedIcon from "@mui/icons-material/ChatOutlined";
import SmartphoneOutlinedIcon from "@mui/icons-material/SmartphoneOutlined";
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
  testConnector,
  updateConnector,
} from "./api";
import AgentSection from "./AgentSection";
import ChatSection from "./ChatSection";
import ModelsSection from "./ModelsSection";
import PhoneSection from "./PhoneSection";
import { StatusIcon } from "./StatusMark";
import ToolsSection from "./ToolsSection";
import UsageSection from "./UsageSection";
import { hasWelcomeMarker, WELCOME_HASH, afterSave, setWelcomeHidden, settingsHash, welcomeBannerStep } from "./welcomeState";

// Settings sections, shown in the left nav. Add new ones here.
const SECTIONS = [
  { id: "connectors", label: "Connectors", icon: <DnsOutlinedIcon />, Component: ConnectorsSection },
  { id: "models", label: "Models", icon: <ViewInArOutlinedIcon />, Component: ModelsSection },
  { id: "tools", label: "Tools", icon: <BuildOutlinedIcon />, Component: ToolsSection },
  { id: "agent", label: "Agent", icon: <SmartToyOutlinedIcon />, Component: AgentSection },
  { id: "chat", label: "Chat", icon: <ChatOutlinedIcon />, Component: ChatSection },
  { id: "phone", label: "Phone", icon: <SmartphoneOutlinedIcon />, Component: PhoneSection },
  { id: "usage", label: "Usage", icon: <BarChartOutlinedIcon />, Component: UsageSection },
];

export default function Settings({
  section,
  welcome = false,
  onClose,
}: {
  section: string;
  // The address carries the getting-started marker.
  welcome?: boolean;
  onClose: () => void;
}) {
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
      {welcome && (
        <Alert
          severity="info"
          icon={false}
          sx={{ borderRadius: 0, alignItems: "center", "& .MuiAlert-message": { width: "100%" } }}
        >
          <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", alignItems: "center", columnGap: 2, rowGap: 0.5 }}>
            <Typography variant="body2" sx={{ flexGrow: 1 }}>
              Getting started{current.id === "connectors" || current.id === "models" ? ", " : ""}
              {welcomeBannerStep(current.id)}
            </Typography>
            <Button size="small" onClick={() => (location.hash = WELCOME_HASH)}>
              Back to checklist
            </Button>
            <Link
              component="button"
              type="button"
              variant="body2"
              onClick={() => {
                setWelcomeHidden(true);
                location.hash = settingsHash(current.id);
              }}
            >
              Exit
            </Link>
          </Stack>
        </Alert>
      )}
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={3}>
          <List component="nav" sx={{ width: { md: 180 }, flexShrink: 0 }}>
            {SECTIONS.map((s) => (
              <ListItemButton
                key={s.id}
                selected={s.id === current.id}
                href={settingsHash(s.id, welcome)}
                sx={{ borderRadius: 1 }}
              >
                <ListItemIcon>{s.icon}</ListItemIcon>
                <ListItemText primary={s.label} />
              </ListItemButton>
            ))}
            <ListItemButton
              onClick={() => {
                setWelcomeHidden(false);
                location.hash = WELCOME_HASH;
              }}
              sx={{ borderRadius: 1 }}
            >
              <ListItemText secondary="Show getting started" />
            </ListItemButton>
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
            llama.cpp servers and Anthropic's API, which this app can talk to. Each chat picks its own connection.
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
              pl: 2,
              pr: 1,
              display: "flex",
              alignItems: "center",
              gap: 1,
            }}
          >
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
                  <StatusIcon kind={c.hasKey ? "done" : "pending"} sx={{ fontSize: "0.875rem" }} />
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
  // The saved key is never sent to the browser, so the field stays empty: typing
  // replaces the saved key, and this drops it (llama servers only).
  const [clearKey, setClearKey] = useState(false);
  const [test, setTest] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the server should do with the key: use the typed one, drop the
  // saved one, or (neither set) keep the saved one.
  const keyInput = { apiKey: apiKey || undefined, clearKey };
  // A llama server needs its address; Anthropic's API, a key (typed or saved).
  const ready = llama ? !!url.trim() : !!apiKey.trim() || !!connector?.hasKey;

  const runTest = () => {
    setTest("checking");
    testConnector({ id: connector?.id, url, kind, ...keyInput })
      .catch((e): TestResult => ({ ok: false, error: e.message }))
      .then((r) => {
        setTest(r);
        // From the getting-started checklist, a good test is the finish line
        // for step 1: save it and go back to the checklist.
        if (r.ok && hasWelcomeMarker(location.hash)) save(r);
      });
  };

  // Once saved, the dialog keeps the connector's id so a retry updates it
  // instead of adding a second one.
  const [savedId, setSavedId] = useState(connector?.id);

  // From the getting-started checklist, saving also finishes step 1: make it
  // test it (unless a good test was just seen); a good test goes back to the
  // checklist, a bad one stays here with the connector saved.
  const save = async (passed?: TestResult) => {
    setSaving(true);
    setError(null);
    try {
      const input = { name, url, kind, api, ...keyInput };
      const saved = await (savedId ? updateConnector(savedId, input) : createConnector(input));
      setSavedId(saved.id);
      const marker = hasWelcomeMarker(location.hash);
      let result = passed;
      if (marker) {
        result ??= await testConnector({ id: saved.id }).catch((e): TestResult => ({ ok: false, error: e.message }));
      }
      const next = afterSave({ marker, test: result });
      if (next === "stay") {
        setError(`Saved, but the connection test failed: ${result && !result.ok ? result.error : "no answer"}. Fix it and save again.`);
        setSaving(false);
        return;
      }
      if (next === "return") location.hash = WELCOME_HASH;
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
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
            <TextField
              fullWidth
              label="API key"
              type="password"
              autoComplete="off"
              required={!llama && !connector?.hasKey}
              disabled={clearKey}
              placeholder={connector?.hasKey ? "Saved key kept. Type to replace it" : llama ? "Optional" : undefined}
              helperText={
                clearKey
                  ? "The saved key will be removed when you save."
                  : `${llama ? "" : "From console.anthropic.com. "}${
                      connector?.hasKey ? "A key is saved; leave this empty to keep it. " : ""
                    }Stored only on this machine, never sent to the browser.`
              }
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTest(null);
              }}
            />
            {/* Anthropic's API needs a key, so only llama servers can drop theirs. */}
            {llama && connector?.hasKey && (
              <Button
                color={clearKey ? "primary" : "error"}
                onClick={() => {
                  setClearKey(!clearKey);
                  setApiKey("");
                  setTest(null);
                }}
                sx={{ mt: "0.5rem", flexShrink: 0 }}
              >
                {clearKey ? "Undo" : "Remove saved key"}
              </Button>
            )}
          </Stack>
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
        <Button onClick={savedId ? onSaved : onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => save()} disabled={!ready || saving}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
