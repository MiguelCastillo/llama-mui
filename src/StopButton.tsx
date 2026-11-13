// The message box's Stop button. A tap is the plain Stop: the model's request
// ends at once, and a tool call that is running is let finish (a command can
// take minutes). Holding it down, right-clicking it, or tapping it again while
// that stop is still waiting opens a menu with Stop everything, which also cuts
// that tool call short (see stopRun in server/runners.ts).

import { useEffect, useRef, useState } from "react";
import { IconButton, ListItemText, Menu, MenuItem, Tooltip } from "@mui/material";
import StopIcon from "@mui/icons-material/Stop";

// How long a press has to last to count as holding the button down.
const HOLD_MS = 500;

export function StopButton({
  onStop,
  onStopAll,
  stopping,
  title,
  label,
  sx,
}: {
  onStop: () => void;
  // Missing: there is nothing more to stop than the plain Stop does.
  onStopAll?: () => void;
  // The plain Stop was sent and the run is finishing what is in flight.
  stopping?: boolean;
  title: string;
  label: string;
  sx: object;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A hold opened the menu, so the click that ends the press does nothing.
  const held = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  useEffect(() => clearHold, []);
  // The run is over: no menu is left to show.
  useEffect(() => {
    if (!onStopAll) setMenuOpen(false);
  }, [onStopAll]);

  const openMenu = () => {
    if (!onStopAll) return;
    held.current = true;
    setMenuOpen(true);
  };

  const tip = !onStopAll
    ? title
    : stopping
      ? "Stopping once the running tool finishes. Tap or hold for Stop everything"
      : `${title}. Hold for Stop everything`;

  return (
    <>
      <Tooltip title={tip}>
        <IconButton
          ref={buttonRef}
          aria-label={stopping ? "Stopping" : label}
          aria-haspopup={onStopAll ? "menu" : undefined}
          onPointerDown={() => {
            held.current = false;
            clearHold();
            if (onStopAll) holdTimer.current = setTimeout(openMenu, HOLD_MS);
          }}
          onPointerUp={clearHold}
          onPointerLeave={clearHold}
          onPointerCancel={clearHold}
          onContextMenu={(e) => {
            if (!onStopAll) return;
            e.preventDefault();
            clearHold();
            openMenu();
          }}
          onClick={() => {
            clearHold();
            if (held.current) {
              held.current = false;
              return;
            }
            // Stop is already on its way: the next thing to offer is Stop everything.
            if (stopping && onStopAll) setMenuOpen(true);
            else onStop();
          }}
          sx={{
            ...sx,
            // A long press on a phone opens this button's menu, not the browser's.
            WebkitTouchCallout: "none",
            userSelect: "none",
            ...(stopping ? { opacity: 0.6 } : {}),
          }}
        >
          <StopIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={buttonRef.current}
        open={menuOpen && !!onStopAll}
        onClose={() => setMenuOpen(false)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <MenuItem
          onClick={() => {
            setMenuOpen(false);
            onStopAll?.();
          }}
        >
          <ListItemText
            primary="Stop everything now"
            secondary="Also cuts short a command or tool that is running"
            slotProps={{ primary: { color: "error" } }}
          />
        </MenuItem>
      </Menu>
    </>
  );
}
