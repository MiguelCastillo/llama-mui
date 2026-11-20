import { Box, Button, ButtonBase, Paper, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import CheckIcon from "@mui/icons-material/Check";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";

// One todo as a card: a box that starts it, and a row of buttons at the bottom
// (Open chat, Done, Remove). It only draws; the caller decides what each does. While `busy`
// the Done and Remove buttons are off; `error` is a plain message under the row.
export default function TodoRow({
  summary,
  detail,
  sessionTitle,
  busy = false,
  error,
  onStart,
  onOpenSession,
  onDone,
  onRemove,
}: {
  summary: string;
  detail: string;
  sessionTitle: string;
  busy?: boolean;
  error?: string;
  onStart: () => void;
  onOpenSession: () => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  // Like the other cards, the actions are a row of buttons at the bottom.
  const action = { minHeight: "2.75rem" };
  return (
    <Paper variant="outlined" data-testid="todo-row">
      <ButtonBase
        onClick={onStart}
        sx={{
          display: "block",
          width: "100%",
          py: 1,
          px: 1.5,
          textAlign: "left",
          borderRadius: 1,
          "&:hover": { bgcolor: "action.hover" },
          "&.Mui-focusVisible": { outline: 2, outlineStyle: "solid", outlineColor: "primary.main" },
        }}
      >
        <Typography
          sx={{
            overflowWrap: "anywhere",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {summary}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {detail}
        </Typography>
      </ButtonBase>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, px: 1, pb: 0.5 }}>
        <Button size="small" sx={action} startIcon={<OpenInNewIcon />} aria-label={`Open session: ${sessionTitle}`} onClick={onOpenSession}>
          Open chat
        </Button>
        <Button size="small" sx={action} startIcon={<CheckIcon />} aria-label={`Done: ${summary}`} disabled={busy} onClick={onDone}>
          Done
        </Button>
        <Button size="small" sx={action} startIcon={<DeleteOutlinedIcon />} aria-label={`Remove: ${summary}`} disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      </Box>
      {error ? (
        <Typography variant="body2" color="error" role="alert" sx={{ px: 1.5, pb: 1 }}>
          {error}
        </Typography>
      ) : null}
    </Paper>
  );
}
