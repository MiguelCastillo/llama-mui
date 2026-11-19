import { useEffect, useState } from "react";
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
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import GppMaybeOutlinedIcon from "@mui/icons-material/GppMaybeOutlined";
import { type DangerousSetting, getDangerousCommands, updateDangerousCommands } from "./api";
import { BUILT_IN_ENTRIES, customEntryProblem, matchDangerous } from "./dangerousCommands";
import { newId } from "./uuid";

// Settings → Tools: the list of commands that always ask, even when a session
// says "approve all commands" (see src/dangerousCommands.ts). The server keeps
// the setting and decides with it; this only shows what the server says and
// sends the user's changes. The test box is a preview on the saved list.

// What the test box says about a sample command. Pure, so it can be tested.
export function testResult(sample: string, setting: DangerousSetting): { text: string; matched: boolean } {
  if (!sample.trim()) return { text: "Type a command to see whether it would always ask.", matched: false };
  if (!setting.enabled) return { text: "The list is switched off, so nothing is forced to ask.", matched: false };
  const hits = matchDangerous(sample, setting);
  return hits.length
    ? { text: `Always asks: ${hits.map((h) => h.label).join("; ")}.`, matched: true }
    : { text: "No match. This command follows the session's normal approval setting.", matched: false };
}

type Draft = { id?: string; label: string; pattern: string };

// The drawing, with no loading or saving, so it can be tested.
export function DangerousCommandsView({
  setting,
  onChange,
  busy = false,
}: {
  setting: DangerousSetting;
  // Sends the fields that changed; resolves when saved, rejects with a plain message.
  onChange: (patch: Partial<DangerousSetting>) => Promise<unknown> | void;
  busy?: boolean;
}) {
  const [sample, setSample] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const result = testResult(sample, setting);

  // For the switches and Remove: a refusal is shown by the section, so it is not rethrown here.
  const send = (patch: Partial<DangerousSetting>) => void Promise.resolve(onChange(patch)).catch(() => {});

  const setBuiltIn = (id: string, on: boolean) =>
    send({ off: on ? setting.off.filter((x) => x !== id) : [...new Set([...setting.off, id])] });

  const saveDraft = async () => {
    if (!draft) return;
    const id = draft.id ?? `custom-${newId().slice(0, 8)}`;
    const entry = { id, label: draft.label.trim() || id, pattern: draft.pattern };
    const problem = customEntryProblem(entry);
    if (problem) return setDraftError(problem);
    const custom = draft.id ? setting.custom.map((c) => (c.id === draft.id ? entry : c)) : [...setting.custom, entry];
    try {
      await onChange({ custom });
      setDraft(null);
      setDraftError(null);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Paper variant="outlined">
      <Stack direction="row" spacing={1.5} sx={{ p: 2, alignItems: "flex-start" }}>
        <Box sx={{ color: "text.secondary", pt: 0.25 }}>
          <GppMaybeOutlinedIcon />
        </Box>
        <Box>
          <Typography variant="h6" sx={{ lineHeight: 1.3 }}>
            Dangerous commands
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Commands in this list always ask you, even in a session set to approve all commands, and that session-wide
            choice isn't offered for them. It matches the command's text, so it is a safety net, not a sandbox: a
            determined or unlucky command can still get past it.
          </Typography>
        </Box>
      </Stack>
      <Divider />
      <ListItem
        sx={{ pr: 10 }}
        secondaryAction={
          <Switch
            edge="end"
            checked={setting.enabled}
            disabled={busy}
            onChange={(e) => send({ enabled: e.target.checked })}
            slotProps={{ input: { "aria-label": "Always ask before dangerous commands" } }}
          />
        }
      >
        <ListItemText
          primary="Always ask before dangerous commands"
          secondary={
            setting.enabled
              ? "On: commands in the list below always ask."
              : "Off: \"approve all commands\" covers every command, including the ones below. Your choices are kept for when you turn it back on."
          }
        />
      </ListItem>
      <Divider />
      <List disablePadding sx={{ opacity: setting.enabled ? 1 : 0.5 }}>
        {BUILT_IN_ENTRIES.map((e) => (
          <ListItem
            key={e.id}
            divider
            sx={{ pr: 10 }}
            secondaryAction={
              <Switch
                edge="end"
                checked={!setting.off.includes(e.id)}
                disabled={busy || !setting.enabled}
                onChange={(ev) => setBuiltIn(e.id, ev.target.checked)}
                slotProps={{ input: { "aria-label": `Ask before: ${e.label}` } }}
              />
            }
          >
            <ListItemText primary={e.label} secondary={e.description} />
          </ListItem>
        ))}
      </List>

      <Box sx={{ p: 2 }}>
        <Typography variant="subtitle1">Your own entries</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Each one is a regular expression tested on every simple command in what the model runs.
        </Typography>
        {setting.custom.length === 0 && !draft && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            None yet.
          </Typography>
        )}
        {setting.custom.map((c) => (
          <Stack key={c.id} direction="row" spacing={1} sx={{ alignItems: "center", py: 0.5 }}>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="body2">{c.label}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
                {c.pattern}
              </Typography>
            </Box>
            <Tooltip title="Edit">
              <IconButton aria-label={`Edit ${c.label}`} disabled={busy} onClick={() => { setDraft({ id: c.id, label: c.label, pattern: c.pattern }); setDraftError(null); }}>
                <EditOutlinedIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remove">
              <IconButton aria-label={`Remove ${c.label}`} disabled={busy} onClick={() => send({ custom: setting.custom.filter((x) => x.id !== c.id) })}>
                <DeleteOutlinedIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        ))}

        {draft ? (
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField size="small" label="Name" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            <TextField
              size="small"
              label="Pattern (regular expression)"
              value={draft.pattern}
              onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
              placeholder="^terraform\s+destroy"
              slotProps={{ htmlInput: { style: { fontFamily: "monospace" } } }}
            />
            {draftError && <Alert severity="error">{draftError}</Alert>}
            <Stack direction="row" spacing={1}>
              <Button variant="contained" size="small" disabled={busy} onClick={() => void saveDraft()}>
                Save entry
              </Button>
              <Button size="small" onClick={() => { setDraft(null); setDraftError(null); }}>
                Cancel
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Button size="small" startIcon={<AddIcon />} disabled={busy} onClick={() => { setDraft({ label: "", pattern: "" }); setDraftError(null); }}>
            Add an entry
          </Button>
        )}
      </Box>

      <Divider />
      <Box sx={{ p: 2 }}>
        <Typography variant="subtitle1">Try a command</Typography>
        <TextField
          size="small"
          fullWidth
          sx={{ mt: 1 }}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder="pkill -f node"
          slotProps={{ htmlInput: { "aria-label": "Sample command", style: { fontFamily: "monospace" } } }}
        />
        <Typography
          variant="body2"
          role="status"
          color={result.matched ? "warning.main" : "text.secondary"}
          sx={{ mt: 1 }}
        >
          {result.text}
        </Typography>
      </Box>
    </Paper>
  );
}

export default function DangerousCommandsSection() {
  // Until the server has answered, nothing about the setting is drawn.
  const [setting, setSetting] = useState<DangerousSetting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getDangerousCommands()
      .then(setSetting)
      .catch((e) => setError(e.message));
  }, []);

  const change = async (patch: Partial<DangerousSetting>) => {
    setBusy(true);
    setError(null);
    try {
      setSetting(await updateDangerousCommands(patch));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A refused entry is shown by the form that sent it; the rest show here.
      if (!("custom" in patch)) setError(message);
      throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {setting ? (
        <DangerousCommandsView setting={setting} busy={busy} onChange={change} />
      ) : (
        !error && <CircularProgress sx={{ alignSelf: "center" }} />
      )}
    </>
  );
}
