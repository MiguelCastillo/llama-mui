import { useState } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  FormControl,
  FormControlLabel,
  FormLabel,
  List,
  ListItem,
  ListItemText,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import type { Preferences } from "./api";
import { usePreferences } from "./usePreferences";
import { setShowSteps, useShowSteps } from "./showSteps";
import { setScrollMode, useScrollMode, type ScrollMode } from "./scrollMode";

// Display options for the chat screen. Add a row to OPTIONS for each new
// boolean preference.
const OPTIONS: { key: keyof Preferences; label: string; summary: string }[] = [
  {
    key: "showContextMeter",
    label: "Show context meter",
    summary:
      "Show how much context is left under the Send button. Click it for token counts and speed.",
  },
  {
    key: "renderMarkdown",
    label: "Render Markdown",
    summary:
      "Show formatting in messages (bold, lists, tables, code blocks with a Copy button), yours and the model's. Off shows the raw text, ** and backticks included.",
  },
  {
    key: "showModelName",
    label: "Show model name",
    summary: "Show which model wrote each reply, in the line under it with the time and speed. Off hides the name; the reply still remembers it.",
  },
];

export default function ChatSection() {
  const [error, setError] = useState<string | null>(null);
  const [prefs, set] = usePreferences(setError);
  const showSteps = useShowSteps();
  const scrollMode = useScrollMode();

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
            {/* Kept in this browser, not in the settings file, so the page knows it
                before it draws a reply (see showSteps.ts). */}
            <ListItem
              divider
              sx={{ pr: 10 }}
              secondaryAction={
                <Switch
                  edge="end"
                  checked={showSteps}
                  onChange={(e) => setShowSteps(e.target.checked)}
                  slotProps={{ input: { "aria-label": "Show steps" } }}
                />
              }
            >
              <ListItemText
                primary="Show steps"
                secondary="Show each round's steps (thinking and tool calls) as a line under its text. Off shows only the text, the answer, and the live line at the bottom while a reply runs. Saved in this browser, so each device has its own; off until you turn it on."
              />
            </ListItem>
            {/* Also kept in this browser (see scrollMode.ts). */}
            <ListItem divider sx={{ display: "block" }}>
              <FormControl>
                <FormLabel id="scroll-mode-label" sx={{ color: "text.primary" }}>
                  When I send a message
                </FormLabel>
                <RadioGroup
                  aria-labelledby="scroll-mode-label"
                  value={scrollMode}
                  onChange={(e) => setScrollMode(e.target.value as ScrollMode)}
                >
                  <FormControlLabel
                    value="follow"
                    control={<Radio />}
                    label={
                      <>
                        <Typography>Keep newest text in view</Typography>
                        <Typography variant="body2" color="text.secondary">
                          The chat scrolls smoothly down as the reply grows. Scroll up to stop it; the arrow brings it back.
                        </Typography>
                      </>
                    }
                  />
                  <FormControlLabel
                    value="pin"
                    control={<Radio />}
                    label={
                      <>
                        <Typography>Move my message to the top</Typography>
                        <Typography variant="body2" color="text.secondary">
                          Your message sits under the top bar and the reply fills in below it, without the page moving.
                        </Typography>
                      </>
                    }
                  />
                </RadioGroup>
              </FormControl>
            </ListItem>
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
