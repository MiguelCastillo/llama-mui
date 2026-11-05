import { useState } from "react";
import { Alert, Box, CircularProgress, List, ListItem, ListItemText, Paper, Stack, Switch, Typography } from "@mui/material";
import type { Preferences } from "./api";
import { usePreferences } from "./usePreferences";

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
  {
    key: "renderMarkdown",
    label: "Render Markdown",
    summary:
      "Show formatting in messages (bold, lists, tables, code blocks with a Copy button), yours and the model's. Off shows the raw text, ** and backticks included.",
  },
];

export default function ChatSection() {
  const [error, setError] = useState<string | null>(null);
  const [prefs, set] = usePreferences(setError);

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
                    onChange={(e) => set({ [o.key]: e.target.checked })}
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
