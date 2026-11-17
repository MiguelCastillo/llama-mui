import { useState } from "react";
import { Alert, Box, CircularProgress, List, ListItem, ListItemText, Paper, Stack, Switch, Typography } from "@mui/material";
import type { Experiments } from "./api";
import { useExperiments } from "./useExperiments";

// The features still being tried, each a switch that is off until turned on.
// Add a row to EXPERIMENTS for each new one (and its key to Experiments in
// src/connections/types.ts and EXPERIMENT_DEFAULTS in server/store.ts).
export const EXPERIMENTS: { key: keyof Experiments; label: string; summary: string }[] = [
  {
    key: "progressNotes",
    label: "Show Claude's progress notes",
    summary:
      "Before a tool call Claude can write a short note about what it is about to do. With this on, those notes are asked for apart from its reasoning summaries, on the models that write them: Fable 5 to 5.2, Mythos 5.1 and 5.2, Opus 5.5 and Sonnet 5.5. It applies to messages sent after you turn it on; other models are not affected. Still being built: chats don't show the notes yet.",
  },
  {
    key: "planWorktrees",
    label: "Run each plan in its own copy of the project",
    summary:
      "Each plan thread works in its own copy of the project (a git worktree) on its own branch, so it can't change your project folder while it runs. It applies to plans started after you turn it on, and only when the chat's folder is a git project. Still being built.",
  },
];

// The rows, for a given state; the section below loads and saves it.
export function ExperimentRows({ experiments, onChange }: { experiments: Experiments; onChange: (changes: Partial<Experiments>) => void }) {
  return (
    <Paper variant="outlined">
      <List disablePadding>
        {EXPERIMENTS.map((x, i) => (
          <ListItem
            key={x.key}
            divider={i < EXPERIMENTS.length - 1}
            // Room for the switch, which is wider than ListItem leaves by default.
            sx={{ pr: 10 }}
            secondaryAction={
              <Switch
                edge="end"
                checked={experiments[x.key]}
                onChange={(e) => onChange({ [x.key]: e.target.checked })}
                slotProps={{ input: { "aria-label": x.label } }}
              />
            }
          >
            <ListItemText primary={x.label} secondary={x.summary} />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}

// "Experimental" on the Models page: what may change or go away, then the switches.
export default function ExperimentalSection() {
  const [error, setError] = useState<string | null>(null);
  const [experiments, set] = useExperiments(setError);

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">Experimental</Typography>
        <Typography color="text.secondary">
          Features still being tried. They are off until you turn them on, and they may change or be removed.
        </Typography>
      </Box>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {!experiments ? !error && <CircularProgress sx={{ alignSelf: "center" }} /> : <ExperimentRows experiments={experiments} onChange={set} />}
    </Stack>
  );
}
