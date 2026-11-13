import { useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { type PersonaList, type Rules, getPersonas, getRules, resetRules, saveRules, setDefaultPersona } from "./api";
import PersonaDefault from "./PersonaDefault";

// Same limit as the server's, so the box can say so before Save.
const MAX_CHARS = 20_000;

// The agent's own rules, kept in ~/.llama-mui/rules.md.
export default function AgentSection() {
  const [saved, setSaved] = useState<Rules | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [personas, setPersonas] = useState<PersonaList | null>(null);

  useEffect(() => {
    getPersonas()
      .then(setPersonas)
      .catch((e) => setError(e.message));
  }, []);

  const choosePersona = (name: string) => {
    setError(null);
    setDefaultPersona(name)
      .then((r) => setPersonas((p) => (p ? { ...p, defaultPersona: r.defaultPersona } : p)))
      .catch((e) => setError(e.message));
  };

  const show = (i: Rules) => {
    setSaved(i);
    setText(i.text);
  };

  useEffect(() => {
    getRules()
      .then(show)
      .catch((e) => setError(e.message));
  }, []);

  const run = (action: Promise<Rules>) => {
    setBusy(true);
    setError(null);
    action
      .then(show)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">Agent</Typography>
        <Typography color="text.secondary">
          Your own rules for the model, in every chat. They tune its built-in way of working and win where they
          differ. Plain text, kept in{" "}
          <code>~/.llama-mui/rules.md</code>; empty means none. The model can propose a line to add, and you approve it.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {personas && (
        <PersonaDefault
          personas={personas.personas}
          chosen={personas.defaultPersona}
          problems={personas.problems.map((p) => `${p.file}: ${p.message}`)}
          folder={personas.folder}
          onChoose={choosePersona}
        />
      )}


      {!saved ? (
        <CircularProgress sx={{ alignSelf: "center" }} />
      ) : (
        <>
          <TextField
            label="Rules"
            multiline
            minRows={6}
            maxRows={24}
            fullWidth
            value={text}
            onChange={(e) => setText(e.target.value)}
            error={text.length > MAX_CHARS}
            helperText={`${text.length} / ${MAX_CHARS} characters. Changes apply from the next message.`}
          />
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={busy || text === saved.text || text.length > MAX_CHARS} onClick={() => run(saveRules(text))}>
              Save
            </Button>
            <Button disabled={busy || saved.isDefault} onClick={() => run(resetRules())}>
              Reset to default
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );
}
