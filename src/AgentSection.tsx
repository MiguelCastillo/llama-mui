import { useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { type Instructions, getInstructions, resetInstructions, saveInstructions } from "./api";

// Same limit as the server's, so the box can say so before Save.
const MAX_CHARS = 20_000;

// The agent's own instructions, kept in ~/.llama-mui/instructions.md.
export default function AgentSection() {
  const [saved, setSaved] = useState<Instructions | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = (i: Instructions) => {
    setSaved(i);
    setText(i.text);
  };

  useEffect(() => {
    getInstructions()
      .then(show)
      .catch((e) => setError(e.message));
  }, []);

  const run = (action: Promise<Instructions>) => {
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
          Instructions the model gets in every chat, after the ones for its tools. Plain text, kept in{" "}
          <code>~/.llama-mui/instructions.md</code>; empty means none.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!saved ? (
        <CircularProgress sx={{ alignSelf: "center" }} />
      ) : (
        <>
          <TextField
            label="Instructions"
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
            <Button variant="contained" disabled={busy || text === saved.text || text.length > MAX_CHARS} onClick={() => run(saveInstructions(text))}>
              Save
            </Button>
            <Button disabled={busy || saved.isDefault} onClick={() => run(resetInstructions())}>
              Reset to default
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );
}
