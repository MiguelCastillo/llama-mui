import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Link, Stack, Tooltip, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import CheckIcon from "@mui/icons-material/Check";
import {
  type Connector,
  type Model,
  getConnectors,
  listModels,
  loadModel,
  setDefaultModel,
  testConnector,
} from "./api";
import { modelReady, setWelcomeHidden, settingsHash, welcomeDone, welcomeSteps } from "./welcomeState";

function Step({ done, title, children }: { done: boolean; title: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
      {/* A mark, not a control: it turns green by itself when the app's state says the step is done. */}
      <CheckIcon
        role="img"
        aria-hidden={false}
        aria-label={`${title}: ${done ? "done" : "not done"}`}
        color={done ? "success" : "disabled"}
        sx={{ mt: 0.25 }}
      />
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 500 }}>{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {children}
        </Typography>
      </Box>
    </Stack>
  );
}

interface Snapshot {
  connector: Connector | null;
  connection: "ok" | "failed";
  models: Model[];
}

// Reads the app's state from the server: the active connector, its test and,
// when that passes, its models. Nothing is stored here.
async function read(): Promise<Snapshot> {
  const l = await getConnectors();
  const connector = l.connectors.find((c) => c.id === l.activeId) ?? null;
  if (!connector) return { connector, connection: "failed", models: [] };
  const test = await testConnector({ id: connector.id }).catch(() => ({ ok: false as const }));
  const models = test.ok ? await listModels(connector.id).catch(() => []) : [];
  return { connector, connection: test.ok ? "ok" : "failed", models };
}

const startChatting = () => {
  setWelcomeHidden(true);
  location.hash = "";
};

// The getting-started page, #/welcome. It reads the app's state when it opens
// and when the window regains focus (which is how it's current after Settings),
// and stays put when both steps are done, on a finish screen.
export default function Welcome() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The model being loaded or chosen, for its "Loading…".
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      read()
        .then((s) => alive && setSnap(s))
        // Can't ask the server: keep the last answer, or show nothing done.
        .catch(() => alive && setSnap((cur) => cur ?? { connector: null, connection: "failed", models: [] }));
    refresh();
    addEventListener("focus", refresh);
    return () => {
      alive = false;
      removeEventListener("focus", refresh);
    };
  }, []);

  if (!snap) return <CircularProgress sx={{ display: "block", mx: "auto", mt: 12 }} />;
  const { connector, connection, models } = snap;
  const steps = welcomeSteps({ connector, connection, models });
  const finished = welcomeDone(steps);
  const kind = connector?.kind ?? "llama";

  // The server loads in the background, so ask again each second until the
  // model is loaded, for up to two minutes (as the chat's model menu does).
  const load = async (id: string) => {
    await loadModel(connector!.id, id);
    for (let i = 0; i < 120; i++) {
      const ms = await listModels(connector!.id);
      setSnap((s) => s && { ...s, models: ms });
      if (ms.find((m) => m.id === id)?.status === "loaded") return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${id} still wasn't loaded after two minutes; check Settings → Models.`);
  };

  const run = async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await work();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  // Loads it first if it needs that, then makes it this connector's default.
  const choose = (m: Model) =>
    run(m.id, async () => {
      if (!modelReady(kind, m)) await load(m.id);
      const saved = await setDefaultModel(connector!, m.id);
      setSnap((s) => s && { ...s, connector: saved });
    });

  return (
    <Stack spacing={2} sx={{ maxWidth: 560, mx: "auto", mt: { xs: 4, sm: 12 }, px: 2, pb: 4 }}>
      <Typography variant="h5" component="h1">
        Welcome to llama-mui. Two things and you're ready.
      </Typography>
      <Step done={steps.connect} title="Connect a server">
        Add your llama.cpp server, or an Anthropic API key.{" "}
        <Link href={settingsHash("connectors", true)}>Open Connectors</Link>
      </Step>
      <Step done={steps.choose} title="Choose a model">
        Chat starts with this one. For a llama server it's loaded first.{" "}
        <Link href={settingsHash("models", true)}>Download or delete models in Settings → Models</Link>
      </Step>
      {steps.connect && !steps.choose && models.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          This server lists no models yet.
        </Typography>
      )}
      {steps.connect && models.length > 0 && (
        <Stack spacing={1} sx={{ pl: { sm: 5 } }}>
          {error && (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {models.map((m) => {
            const selected = connector!.defaultModel === m.id;
            return (
              <Stack
                key={m.id}
                direction="row"
                useFlexGap
                spacing={1}
                sx={{ alignItems: "center", flexWrap: "wrap", border: 1, borderColor: "divider", borderRadius: 1, p: 1 }}
              >
                <Typography sx={{ fontFamily: kind === "llama" ? "monospace" : undefined, overflowWrap: "anywhere", flex: "1 1 200px", minWidth: 0 }}>
                  {m.name ?? m.id}
                </Typography>
                {kind === "llama" && m.status && (
                  <Chip size="small" variant="outlined" label={m.status} color={m.status === "loaded" ? "success" : "default"} />
                )}
                {kind === "llama" && m.status === "unloaded" && busy !== m.id && (
                  <Tooltip title="Load model">
                    <span>
                      <IconButton
                        size="small"
                        disabled={busy !== null}
                        aria-label={`Load ${m.id}`}
                        onClick={() => run(m.id, () => load(m.id))}
                      >
                        <PlayArrowIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                {busy === m.id ? (
                  <Typography variant="body2" role="status">
                    Loading…
                  </Typography>
                ) : (
                  <Button size="small" variant={selected ? "contained" : "outlined"} disabled={busy !== null || (selected && modelReady(kind, m))} onClick={() => choose(m)}>
                    {selected && modelReady(kind, m) ? "Chosen" : "Use this one"}
                  </Button>
                )}
              </Stack>
            );
          })}
        </Stack>
      )}
      {finished ? (
        <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
          <Typography role="status" color="success.main" sx={{ fontWeight: 500 }}>
            You're all set.
          </Typography>
          <Button variant="contained" onClick={startChatting}>
            Start chatting
          </Button>
        </Stack>
      ) : (
        <>
          {steps.connect && (
            <Typography role="status" color="success.main">
              Connected. Next: choose a model.
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            Then type a message in the chat.{" "}
            <Link component="button" type="button" onClick={startChatting} sx={{ verticalAlign: "baseline" }}>
              Exit
            </Link>
          </Typography>
        </>
      )}
    </Stack>
  );
}
