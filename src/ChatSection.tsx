import { useEffect, useState } from "react";
import { Alert, Box, CircularProgress, List, ListItem, ListItemText, Paper, Stack, Switch, Typography } from "@mui/material";
import { type Preferences, getPreferences, updatePreferences } from "./api";

// Display options for the chat screen. Add a row to OPTIONS for each new
// boolean preference.
const OPTIONS: { key: keyof Preferences; label: string; summary: string }[] = [
  {
    key: "showContextMeter",
    label: "Show context meter",
    summary:
      "Show how much context is left under the Send button. Click it for token counts, speed and Clear context; turning this off hides Clear context too.",
  },
  {
    key: "showSteps",
    label: "Show steps",
    summary: "Show the model's thinking and tool calls inside each reply, with how long each took. Off shows just the answer.",
  },
];

export default function ChatSection() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPreferences()
      .then(setPrefs)
      .catch((e) => setError(e.message));
  }, []);

  const set = (key: keyof Preferences, value: boolean) => {
    // Flip it right away; the server's answer either confirms it or puts it back.
    setPrefs((p) => p && { ...p, [key]: value });
    updatePreferences({ [key]: value })
      .then(setPrefs)
      .catch((e) => {
        setError(e.message);
        getPreferences().then(setPrefs);
      });
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">Chat</Typography>
        <Typography color="text.secondary">How the chat screen looks.</Typography>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!prefs ? (
        <CircularProgress sx={{ alignSelf: "center" }} />
      ) : (
        <Paper variant="outlined">
          <List disablePadding>
            {OPTIONS.map((o, i) => (
              <ListItem
                key={o.key}
                divider={i < OPTIONS.length - 1}
                // Room for the switch, which is wider than ListItem leaves by default.
                sx={{ pr: 10 }}
                secondaryAction={
                  <Switch
                    edge="end"
                    checked={prefs[o.key]}
                    onChange={(e) => set(o.key, e.target.checked)}
                    slotProps={{ input: { "aria-label": o.label } }}
                  />
                }
              >
                <ListItemText primary={o.label} secondary={o.summary} />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}
    </Stack>
  );
}
