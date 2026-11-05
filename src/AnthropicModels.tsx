import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  FormControlLabel,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import DefaultButton from "./DefaultButton";
import { type Connector, type Model, listModels } from "./api";

// Anthropic's API: the Claude models the key can use, to pick from in chat.
// There's nothing to download, load or delete; Think is the one option.
export default function AnthropicModels({
  connector,
  think,
  setThink,
  changeDefault,
}: {
  connector: Connector;
  think: (id: string) => boolean;
  setThink: (id: string, think: boolean) => void;
  changeDefault: (id: string) => void;
}) {
  const [models, setModels] = useState<Model[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listModels(connector.id)
      .then(setModels)
      .catch((e) => setError(e.message));
  }, [connector.id]);

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">Models</Typography>
        <Typography color="text.secondary">
          The Claude models {connector.name} offers your key. Pick one in chat; Anthropic runs them, so there's nothing
          to download or load.
        </Typography>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {!models ? (
        !error && <CircularProgress sx={{ alignSelf: "center" }} />
      ) : (
        <Paper variant="outlined">
          <List disablePadding>
            {models.map((m, i) => (
              <ListItem key={m.id} divider={i < models.length - 1} sx={{ gap: 2 }}>
                <ListItemText
                  primary={m.name ?? m.id}
                  secondary={
                    <>
                      <Typography component="span" variant="body2" sx={{ fontFamily: "monospace" }}>
                        {m.id}
                      </Typography>
                      {m.contextSize ? ` · ${m.contextSize.toLocaleString()}-token context` : ""}
                    </>
                  }
                />
                <DefaultButton id={m.id} current={connector.defaultModel} change={changeDefault} />
                {/* On: Claude thinks as it sees fit and shows a summary. */}
                <Tooltip title="Think before answering. Claude's message in chat gets a Thoughts bar with a summary of its thinking.">
                  <FormControlLabel
                    label="Think"
                    labelPlacement="start"
                    control={
                      <Switch
                        checked={think(m.id)}
                        onChange={(e) => setThink(m.id, e.target.checked)}
                        slotProps={{ input: { "aria-label": `Think before answering with ${m.id}` } }}
                      />
                    }
                    sx={{ mr: 0, flexShrink: 0 }}
                  />
                </Tooltip>
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      {/* Explains the Think switch on each model's row, so it sits right under them. */}
      {models && (
        <Typography variant="body2" color="text.secondary">
          <b>Think</b> (before answering) lets Claude think as it sees fit before it writes its answer. In chat,
          Claude's message then starts with a grey bar labelled <b>Thoughts</b>, above the answer; click the bar to read
          a summary of what Claude thought; the time it spent thinking shows at the bar's right end. (The bar needs{" "}
          <b>Show steps</b> on in Settings → Chat.) Thinking can help with hard questions but is slower. Off, Claude isn't asked to think,
          though some models may still think briefly, and you won't see it.
        </Typography>
      )}
    </Stack>
  );
}
