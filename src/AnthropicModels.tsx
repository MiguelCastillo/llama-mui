import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import DefaultButton from "./DefaultButton";
import { type Connector, type Effort, type Model, type ModelSettings, listModels } from "./api";
import ModelKnobs from "./ModelKnobs";

// Anthropic's API: the Claude models the key can use, to pick from in chat.
// There's nothing to download, load or delete; Effort is the one option.
export default function AnthropicModels({
  connector,
  settingsFor,
  changeSetting,
  changeDefault,
}: {
  connector: Connector;
  settingsFor: (id: string) => ModelSettings;
  changeSetting: (id: string, changes: { think?: boolean; effort?: Effort | undefined }) => void;
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
                {/* Effort, when this model takes it (its own capabilities say). */}
                <ModelKnobs kind="anthropic" id={m.id} capabilities={m.capabilities} settings={settingsFor(m.id)} change={changeSetting} />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      {/* Explains the Effort picker on each model's row, so it sits right under them. */}
      {models && (
        <Typography variant="body2" color="text.secondary">
          Claude thinks before every answer and between tool calls, as much as it sees fit. <b>Effort</b> sets how
          much: <b>low</b> is quicker and cheaper, <b>high</b>, <b>xhigh</b> and <b>max</b> think longer and more
          carefully. <b>Default</b> sends nothing, so the model's own default applies. Each
          message carries the effort set when it was sent, queued ones included. Models differ in what they take: one
          that takes no effort (Haiku 4.5) has no picker, and the others list only the levels they support. In
          chat, each round of Claude's work has a grey line such as <b>2 steps</b>; click it to open the steps, where a
          bar labelled <b>Thoughts</b> holds a summary of what Claude thought; the time it spent shows at the bar's
          right end.
        </Typography>
      )}
    </Stack>
  );
}
