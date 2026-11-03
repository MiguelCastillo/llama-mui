import { useState } from "react";
import {
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { ago } from "./SessionsPanel";
import type { Start, TodoGroup } from "./todos";

// "My Todos…" under the empty chat's suggestions: opens every open todo from
// past sessions as a list of boxes, newest session first. A box starts that todo
// in its session (onStart: the chat opens the session, sets a context boundary
// and sends the todo). Its icon only opens the session.
// Shows nothing when there are no groups.
export default function MyTodos({
  groups,
  onStart,
  onOpenSession,
}: {
  groups: TodoGroup[];
  onStart: (start: Start) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!groups.length) return null;
  const close = () => setOpen(false);
  const count = groups.reduce((n, g) => n + g.todos.length, 0);

  return (
    <>
      <Button
        variant="outlined"
        color="inherit"
        size="small"
        onClick={() => setOpen(true)}
        sx={{ borderColor: "divider", borderRadius: 2, textTransform: "none", fontWeight: 400 }}
      >
        My Todos…
      </Button>
      <Dialog
        open={open}
        onClose={close}
        fullWidth
        maxWidth="sm"
        scroll="paper"
        sx={{ "& .MuiDialog-paper": { mx: { xs: 1, sm: 4 }, width: { xs: "calc(100% - 16px)", sm: undefined } } }}
      >
        <DialogTitle>
          My Todos{" "}
          <Typography component="span" color="text.secondary">
            {count} {count === 1 ? "todo" : "todos"}
          </Typography>
        </DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 1, sm: 3 } }}>
          <Stack spacing={1}>
            {groups.flatMap((g) =>
              g.todos.map((todo) => (
                <Paper key={`${g.sessionId}:${todo.id}`} variant="outlined" sx={{ display: "flex", alignItems: "center", pr: 1 }}>
                  <ButtonBase
                    onClick={() => {
                      onStart({ sessionId: g.sessionId, todoId: todo.id, summary: todo.summary });
                      close();
                    }}
                    sx={{
                      flexGrow: 1,
                      minWidth: 0,
                      py: 1,
                      px: 1.5,
                      textAlign: "left",
                      display: "block",
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
                      {todo.summary}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                      {g.title}
                      {g.updatedAt ? ` · ${ago(g.updatedAt)}` : ""}
                    </Typography>
                  </ButtonBase>
                  <Tooltip title="Open session">
                    <IconButton
                      size="small"
                      aria-label={`Open session: ${g.title}`}
                      onClick={() => {
                        onOpenSession(g.sessionId);
                        close();
                      }}
                      sx={{ ml: 0.5 }}
                    >
                      <OpenInNewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Paper>
              )),
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close} color="inherit">
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
