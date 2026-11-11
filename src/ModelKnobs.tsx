import { FormControlLabel, MenuItem, Switch, TextField, Tooltip } from "@mui/material";
import { type Capabilities, type Effort, type Kind, type ModelSettings } from "./api";
import { connection } from "./connections/index";

// The settings one model row shows, whatever the connection: the knobs its
// connection kind gives that model (src/connections), as controls. A Claude
// model that takes no effort shows none; one that does lists only the levels
// it supports; a llama.cpp model has Think. `change` is told what changed;
// effort undefined goes back to the model's own default.
export default function ModelKnobs({
  kind,
  id,
  capabilities,
  settings,
  change,
}: {
  kind: Kind | undefined;
  id: string;
  capabilities?: Capabilities;
  settings: ModelSettings;
  change: (id: string, changes: { think?: boolean; effort?: Effort | undefined }) => void;
}) {
  return (
    <>
      {connection(kind)
        .knobs(capabilities)
        .map((knob) =>
          knob.key === "think" ? (
            // Short label so it stays on the model's line; the note below explains it.
            <Tooltip key="think" title={knob.help}>
              <FormControlLabel
                label={knob.label}
                labelPlacement="start"
                control={
                  <Switch
                    checked={settings.think}
                    onChange={(e) => change(id, { think: e.target.checked })}
                    slotProps={{ input: { "aria-label": `Think before answering with ${id}` } }}
                  />
                }
                sx={{ mr: 0, flexShrink: 0 }}
              />
            </Tooltip>
          ) : (
            // Sent with each message; Default sends nothing.
            <Tooltip key="effort" title={knob.help} placement="left">
              <TextField
                select
                size="small"
                label={knob.label}
                // A saved level the model no longer takes shows as Default.
                value={settings.effort && knob.levels.includes(settings.effort) ? settings.effort : ""}
                onChange={(e) => change(id, { effort: (e.target.value || undefined) as Effort | undefined })}
                slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true }, htmlInput: { "aria-label": `Effort for ${id}` } }}
                sx={{ minWidth: "8rem", flexShrink: 0 }}
              >
                <MenuItem value="">Default</MenuItem>
                {knob.levels.map((level) => (
                  <MenuItem key={level} value={level}>
                    {level}
                  </MenuItem>
                ))}
              </TextField>
            </Tooltip>
          ),
        )}
    </>
  );
}
