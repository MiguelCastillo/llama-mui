import { useEffect, useState } from "react";
import { Alert, Box, Stack, Typography } from "@mui/material";
import { type PersonaList, getPersonas, setDefaultPersona } from "./api";
import PersonaDefault from "./PersonaDefault";

// Settings → Agent: the persona new chats start with, and where the user's own
// rules are kept. The rules aren't edited here: the model proposes a line and
// the user approves it (add_rule), and the file is plain text for anyone who
// wants to change it by hand.
export default function AgentSection() {
  const [personas, setPersonas] = useState<PersonaList | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Agent</Typography>

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

      <Box>
        <Typography variant="h6">Your rules</Typography>
        <Typography color="text.secondary">
          Rules you've kept for every chat are in <code>~/.llama-mui/rules.md</code>. When you ask the model to
          remember something, it proposes a line and you approve it.
        </Typography>
      </Box>
    </Stack>
  );
}
