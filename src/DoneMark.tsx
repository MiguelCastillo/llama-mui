// Every "done" in the UI (a finished thread, a done plan step, a done action
// box) uses this one icon: an outlined check circle in the success colour.
// Change the look here, not at the call sites. Sizes at a call site are set with
// fontSize or sx, in rem or em only (px is for borders).
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import type { SvgIconProps } from "@mui/material/SvgIcon";

// The colour is not a prop on purpose, so a call site can't drift from it.
export function DoneIcon({ "aria-label": ariaLabel = "Done", ...props }: Omit<SvgIconProps, "color">) {
  return <CheckCircleOutlinedIcon {...props} color="success" aria-label={ariaLabel} />;
}
