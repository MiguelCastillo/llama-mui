import { Box, MenuItem, Select, Tooltip, Typography } from "@mui/material";
import type { PersonaInfo } from "./api";

// Whether the chat shows the persona control beside the message box. Off for
// now: new chats use the default persona (Settings → Agent). Turn it on to show
// the picker again; its look should first match the folder chip beside it.
export const PERSONA_PICKER_IN_CHAT = false;

// The persona control beside the message box. On an empty chat it is a small
// picker (each choice shows its description); once the first message is sent
// the persona is fixed (see persona.ts), so it becomes a read-only label.
// `problems` are plain messages about persona files that couldn't be used.
export default function PersonaPicker({
  personas,
  chosen,
  fixed,
  problems,
  onChoose,
  toolsOn = true,
}: {
  // Personas only apply when tools are on (see workingRules); with tools off
  // there is no choice to offer, so a persona that would be ignored isn't saved.
  toolsOn?: boolean;
  personas: PersonaInfo[];
  // The persona in use: the one saved with the chat, else the default.
  chosen: string;
  fixed: boolean;
  problems: string[];
  onChoose: (name: string) => void;
}) {
  if (!toolsOn) {
    return (
      <Tooltip title="Personas shape how the assistant uses tools. Turn tools on to choose one.">
        <Typography variant="caption" color="text.secondary" noWrap data-testid="persona-needs-tools">
          Personas need tools
        </Typography>
      </Tooltip>
    );
  }
  const description = personas.find((p) => p.name === chosen)?.description;
  if (fixed) {
    return (
      <Tooltip title={description || "The persona this chat started with. It can't change; start a new chat to use another."}>
        <Typography variant="caption" color="text.secondary" noWrap data-testid="persona-label">
          Persona: {chosen}
        </Typography>
      </Tooltip>
    );
  }
  // A name that is no longer listed still shows, so the box isn't blank.
  const names = personas.some((p) => p.name === chosen) ? personas : [{ name: chosen, description: "" }, ...personas];
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
      <Select
        size="small"
        variant="standard"
        disableUnderline
        value={chosen}
        onChange={(e) => onChoose(String(e.target.value))}
        inputProps={{ "aria-label": "Persona" }}
        renderValue={(v) => `Persona: ${v}`}
        sx={{ fontSize: "0.75rem", color: "text.secondary", minWidth: 0 }}
        data-testid="persona-picker"
      >
        {names.map((p) => (
          <MenuItem key={p.name} value={p.name}>
            <Box>
              <Typography variant="body2">{p.name}</Typography>
              {p.description && (
                <Typography variant="caption" color="text.secondary">
                  {p.description}
                </Typography>
              )}
            </Box>
          </MenuItem>
        ))}
      </Select>
      {problems.length > 0 && (
        <Tooltip title={problems.join("\n")}>
          <Typography variant="caption" color="warning.main" noWrap data-testid="persona-problems">
            Some persona files had problems (see Settings → Agent).
          </Typography>
        </Tooltip>
      )}
    </Box>
  );
}
