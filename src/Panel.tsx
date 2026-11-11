import type { ReactNode } from "react";
import { Box, Button, IconButton, Stack, Tooltip, alpha } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTapReveal } from "./tapReveal";

// One reusable panel for the boxes under a reply (ideas, action items) and for
// the messages you send. Each kind of panel gets its look from the table below,
// so a change of look is made once, here, and not on each panel.
//
// A panel has two kinds of buttons, each in its own slot:
// - "tools" act on the content itself (copy it, show it raw, show hidden
//   notes). They are small icon-only buttons (PanelButton) in a toolbar at the
//   panel's top right corner, shown when the panel is hovered.
// - "actions" respond to the content (Do it, Add to todos, Make plan). They are
//   always visible, labelled buttons (PanelAction) in a row under the text,
//   left-aligned and styled like the buttons in the approval prompts: the main
//   answer is a filled button, the others are outlined.

export type PanelVariant = "idea" | "action" | "actionDone" | "message" | "messageAside" | "reply" | "replyAside";

export const PANEL_VARIANTS: Record<PanelVariant, SxProps<Theme>> = {
  // Standing out, but less than an action: an info-coloured bar and tint.
  idea: {
    display: "flex",
    flexWrap: "wrap",
    gap: 1.25,
    alignItems: "flex-start",
    px: 1.5,
    py: 1.25,
    borderLeft: 4,
    borderLeftColor: "info.main",
    borderRadius: 1,
    bgcolor: (t) => alpha(t.palette.info.main, 0.1),
  },
  // Loud: a warning-coloured bar and a light tint.
  action: {
    display: "flex",
    flexWrap: "wrap",
    gap: 1,
    alignItems: "center",
    px: 1.5,
    py: 1,
    borderLeft: 4,
    borderLeftColor: "warning.main",
    borderRadius: 1,
    bgcolor: (t) => alpha(t.palette.warning.main, 0.1),
  },
  // An action the user marked done: the same shape, but quiet: a grey bar and
  // a faint grey fill instead of the warning colour.
  actionDone: {
    display: "flex",
    flexWrap: "wrap",
    gap: 1,
    alignItems: "center",
    px: 1.5,
    py: 1,
    borderLeft: 4,
    borderLeftColor: "divider",
    borderRadius: 1,
    bgcolor: "action.hover",
  },
  // What you typed: quieter than the reply, a faint tint of the theme's colour
  // behind normal text, not a solid fill. What you typed is one block, so the
  // panel pads itself.
  message: {
    px: 2,
    py: 1.5,
    width: "100%",
    maxWidth: "100%",
    borderRadius: 1,
    bgcolor: (t) => alpha(t.palette.primary.main, 0.14),
    color: "text.primary",
  },
  // A side question: quieter still, a dashed outline and a fainter tint.
  messageAside: {
    px: 2,
    py: 1.5,
    width: "100%",
    maxWidth: "100%",
    borderRadius: 1,
    border: 1,
    borderColor: "divider",
    borderStyle: "dashed",
    bgcolor: (t) => alpha(t.palette.primary.main, 0.06),
    color: "text.primary",
  },
  // The model's reply: it sits on the page, no border, fill or padding of its
  // own (its step rows run edge to edge, and each text block pads itself).
  reply: {
    width: "100%",
    maxWidth: "100%",
    color: "text.primary",
  },
  // The model's answer to a side question: a dashed outline and a light fill.
  replyAside: {
    width: "100%",
    maxWidth: "100%",
    borderRadius: 1,
    border: 1,
    borderColor: "divider",
    borderStyle: "dashed",
    bgcolor: "action.hover",
    color: "text.primary",
  },
};

// The row of icon buttons: fits its buttons and sits at the top right corner of
// the panel, moved a quarter of a rem left and up. Hidden until the panel is
// hovered. Offsets are rem, so they scale with the font size.
const toolbarSx: SxProps<Theme> = {
  position: "absolute",
  top: "-0.25rem",
  right: "0.25rem",
  zIndex: 1,
  p: 0,
  bgcolor: "background.paper",
  border: 1,
  borderColor: "divider",
  borderRadius: 1.5,
  boxShadow: 1,
  opacity: 0,
  transition: "opacity 0.15s",
};

// Shows the toolbar on hover or when a button in it has keyboard focus. Where
// there is no hover (touch) it stays hidden, and can't be tapped by accident,
// until the box is tapped open (the box carries data-tap-open, see
// useTapReveal). Goes on the box the toolbar sits in. Only that box's own
// toolbar (its direct child) is shown: a panel nested in another (an action box
// in a reply) keeps its toolbar hidden until the nested panel itself is
// hovered or tapped.
export const revealToolbarSx = {
  "&:hover > .hover-toolbar, &:focus-within > .hover-toolbar": { opacity: 1 },
  "@media (hover: none)": {
    "& > .hover-toolbar": { pointerEvents: "none" },
    "&[data-tap-open] > .hover-toolbar": { opacity: 1, pointerEvents: "auto" },
  },
};

// The hover toolbar on its own, for a box that isn't a Panel but should act
// like one (a table in a reply). Put it inside a box with position "relative"
// and revealToolbarSx, and fill it with PanelButtons.
export function PanelToolbar({ children }: { children: ReactNode }) {
  return (
    <Stack className="hover-toolbar" direction="row" spacing={0} sx={toolbarSx}>
      {children}
    </Stack>
  );
}

// Every icon in a panel toolbar is one of these, so size, colour and tooltip
// behaviour stay the same. The span lets the tooltip still show when the
// button is disabled.
export function PanelButton({
  label,
  icon,
  onClick,
  disabled,
  pressed,
}: {
  // Tooltip text and the button's accessible name.
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  // For a toggle: whether it is on. Left out, the button is not a toggle.
  pressed?: boolean;
}) {
  return (
    <Tooltip title={label}>
      <span>
        <IconButton
          size="small"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          aria-pressed={pressed !== undefined ? pressed : undefined}
          // Brighter than the secondary grey (the main text colour), and the
          // icons a size down from MUI's 24px default, whatever the caller passes.
          // The hover and focus highlight is a rounded square, not MUI's circle.
          sx={{ color: "text.primary", borderRadius: 1, p: "0.4375rem", "& .MuiSvgIcon-root": { fontSize: "1.125rem" } }}
        >
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}

// Every labelled button in a panel's row of actions is one of these: a small
// button with no icon, like the ones in the approval prompts. The main answer
// is "contained"; secondary ones are "outlined".
export function PanelAction({
  label,
  onClick,
  disabled,
  variant,
  color,
  title,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "contained" | "outlined" | "text";
  color?: "inherit" | "primary" | "secondary" | "success" | "error" | "info" | "warning";
  // A longer explanation, shown by the browser when hovering the button.
  title?: string;
}) {
  return (
    <Button
      size="small"
      variant={variant ?? "outlined"}
      color={color}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {label}
    </Button>
  );
}

export default function Panel({
  variant,
  tools,
  actions,
  error,
  children,
}: {
  variant: PanelVariant;
  // Icon buttons for the hover toolbar (they act on the content); no toolbar
  // when left out.
  tools?: ReactNode;
  // Labelled buttons in a visible row under the content (they respond to it);
  // no row when left out.
  actions?: ReactNode;
  // Draws the error border (a failed message).
  error?: boolean;
  children?: ReactNode;
}) {
  const tapReveal = useTapReveal();
  return (
    <Box {...tapReveal} sx={{ position: "relative", width: "100%", ...revealToolbarSx }}>
      <Box
        data-note={variant === "idea" ? "idea" : variant === "action" || variant === "actionDone" ? "action" : undefined}
        sx={[PANEL_VARIANTS[variant], error && { border: 1, borderColor: "error.main" }] as SxProps<Theme>}
      >
        {children}
        {actions && (
          <Stack direction="row" spacing={1} sx={{ flexBasis: "100%", mt: 1.5, flexWrap: "wrap", rowGap: 1 }}>
            {actions}
          </Stack>
        )}
      </Box>
      {tools && <PanelToolbar>{tools}</PanelToolbar>}
    </Box>
  );
}
