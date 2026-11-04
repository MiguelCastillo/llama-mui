import { useEffect, useMemo, useState } from "react";
import { Box, ButtonBase, Typography, useMediaQuery } from "@mui/material";
import { listSessions } from "./api";
import MyTodos from "./MyTodos";
import { pickSuggestions, visibleCount } from "./suggestions";
import { todoGroups, type Start, type TodoSession } from "./todos";

// A few random starters under the empty chat's message, and a "My Todos…"
// button when past sessions have unfinished plan steps (the session list
// carries them). A click starts it at once (onStart): a starter is sent as the
// first message, a todo is worked on in its own session. The dialog can also just
// open the session a todo is from.
export default function EmptyChatSuggestions({
  onStart,
  onOpenSession,
}: {
  onStart: (start: Start) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<TodoSession[] | null>(null);
  useEffect(() => {
    let live = true;
    listSessions()
      .then((rows) => {
        if (!live) return;
        setSessions(
          rows.map((r) => ({
            id: r.id,
            title: r.userName || r.modelName || r.title,
            updatedAt: r.updatedAt,
            todos: r.todos ?? [],
          })),
        );
      })
      .catch(() => {
        // No todos; the starters stay.
      });
    return () => {
      live = false;
    };
  }, []);

  // Picked once, so nothing reshuffles when the todos arrive.
  const picks = useMemo(() => pickSuggestions(), []);
  const groups = useMemo(() => todoGroups(sessions ?? []), [sessions]);
  // Three are picked once and the first few shown, so resizing doesn't reshuffle.
  const short = useMediaQuery("(max-height: 40rem)");
  const shown = picks.slice(0, visibleCount(groups.length > 0, short));

  return (
    <Box
      sx={{
        position: "absolute",
        top: "calc(100% + 1rem)",
        left: 0,
        right: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.75,
        px: 2,
      }}
    >
      {shown.map((text) => (
        <ButtonBase
          key={text}
          onClick={() => onStart({ text })}
          sx={{
            maxWidth: "100%",
            px: 1.5,
            py: 0.75,
            borderRadius: 2,
            border: 1,
            borderColor: "divider",
            "&:hover": { bgcolor: "action.hover" },
            "&.Mui-focusVisible": { outline: 2, outlineStyle: "solid", outlineColor: "primary.main" },
          }}
        >
          <Typography variant="body2" noWrap sx={{ maxWidth: "100%" }}>
            {text}
          </Typography>
        </ButtonBase>
      ))}
      <MyTodos groups={groups} onStart={onStart} onOpenSession={onOpenSession} />
    </Box>
  );
}
