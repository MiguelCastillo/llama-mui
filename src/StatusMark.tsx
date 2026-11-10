// Every status look in the UI (a plan step, a thread note heading, a failed or
// finished reply) comes from the table in this file. Change a look here, not at
// the call sites. Sizes at a call site are set with fontSize or sx, in rem or em
// only (px is for borders).
//
//   running   spinner                       something is working right now
//   pending   grey empty circle             not started yet
//   done      green outlined check          finished fine
//   failed    red outlined exclamation      an error, or a step that failed
//   needsYou  amber outlined question mark  waiting on the user, or disputed
//   stopped   amber warning triangle        ended without finishing
//
// Also used by: the Welcome checklist (done / pending checks and the two
// success lines), the key row in Settings (done beside "key saved", pending
// beside "no key"), and "Needs you" on a thread note and in the sessions list.
// Chips (Online/Offline, model loaded) and MUI Alerts are deliberately not part
// of this table.
import { CircularProgress } from "@mui/material";
import type { SvgIconProps } from "@mui/material/SvgIcon";
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";

export type StatusKind = "running" | "pending" | "done" | "failed" | "needsYou" | "stopped";

// The colour is not a prop on purpose, so a call site can't drift from it.
export type StatusIconProps = Omit<SvgIconProps, "color"> & { kind: StatusKind };

// The same sizes MUI gives an icon's fontSize, so the spinner matches the icons.
const SPINNER_FONT_SIZE = { inherit: "inherit", small: "1.25rem", medium: "1.5rem", large: "2.1875rem" } as const;

export function StatusIcon({ kind, fontSize = "medium", sx, "aria-label": ariaLabel, ...props }: StatusIconProps) {
  switch (kind) {
    case "running":
      // The spinner is not an svg icon: it takes its size from the font size (1em).
      return (
        <CircularProgress
          size="1em"
          aria-label={ariaLabel ?? "Running"}
          sx={[{ fontSize: SPINNER_FONT_SIZE[fontSize], flexShrink: 0 }, ...(Array.isArray(sx) ? sx : [sx])]}
        />
      );
    case "pending":
      return <RadioButtonUncheckedIcon {...props} fontSize={fontSize} sx={sx} color="disabled" aria-label={ariaLabel ?? "Not started"} />;
    case "done":
      return <CheckCircleOutlinedIcon {...props} fontSize={fontSize} sx={sx} color="success" aria-label={ariaLabel ?? "Done"} />;
    case "failed":
      return <ErrorOutlineIcon {...props} fontSize={fontSize} sx={sx} color="error" aria-label={ariaLabel ?? "Failed"} />;
    case "needsYou":
      return <HelpOutlineIcon {...props} fontSize={fontSize} sx={sx} color="warning" aria-label={ariaLabel ?? "Needs you"} />;
    case "stopped":
      return <WarningAmberIcon {...props} fontSize={fontSize} sx={sx} color="warning" aria-label={ariaLabel ?? "Not finished"} />;
  }
}

// Kept so the existing "done" call sites still work: it is StatusIcon, kind done.
export function DoneIcon(props: Omit<StatusIconProps, "kind">) {
  return <StatusIcon {...props} kind="done" />;
}
