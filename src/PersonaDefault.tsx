import { Alert, Box, MenuItem, Stack, TextField, Typography } from "@mui/material";
import type { PersonaInfo } from "./api";

// Where persona files live, when the server doesn't say.
export const PERSONAS_FOLDER = "the app's personas folder";

// Settings → Agent: choose the persona new chats start with, see where the
// persona files are, and read any problems found in them.
export default function PersonaDefault({
  personas,
  chosen,
  problems,
  disabled,
  folder,
  onChoose,
}: {
  personas: PersonaInfo[];
  chosen: string;
  problems: string[];
  disabled?: boolean;
  folder?: string;
  onChoose: (name: string) => void;
}) {
  return (
    <Stack spacing={1.5} data-testid="persona-default">
      <Box>
        <Typography variant="h6">Personas</Typography>
        <Typography color="text.secondary">
          A persona tells the model how to work. New chats start with the default below; each chat keeps its persona once
          the first message is sent; edits to a persona's file reach a chat after Clear context. Each persona is a file
          in <code>{folder ?? PERSONAS_FOLDER}</code>.
        </Typography>
      </Box>
      <TextField
        select
        size="small"
        label="Default persona"
        value={chosen}
        disabled={disabled}
        onChange={(e) => onChoose(e.target.value)}
        helperText="Applies to chats you start from now on."
      >
        {personas.map((p) => (
          <MenuItem key={p.name} value={p.name}>
            {p.name}
            {p.description ? ` — ${p.description}` : ""}
          </MenuItem>
        ))}
      </TextField>
      {problems.length > 0 && (
        <Alert severity="warning" data-testid="persona-problems">
          Some persona files had problems:
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
    </Stack>
  );
}
