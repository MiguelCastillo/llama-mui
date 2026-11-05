import { IconButton, Tooltip } from "@mui/material";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";

// The star on a model's row: the default is the one chat starts with on this
// server. Clicking the default clears it.
export default function DefaultButton({
  id,
  current,
  change,
}: {
  id: string;
  current?: string;
  change: (id: string) => void;
}) {
  const on = current === id;
  return (
    <Tooltip title={on ? "Default model; click to clear" : "Make default"}>
      <IconButton
        size="small"
        onClick={() => change(on ? "" : id)}
        aria-label={on ? `Clear default model ${id}` : `Make ${id} the default model`}
        aria-pressed={on}
      >
        {on ? <StarIcon fontSize="small" color="primary" /> : <StarBorderIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}
