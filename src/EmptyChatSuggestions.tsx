import { useEffect, useMemo, useState } from "react";
import { Box, ButtonBase, Typography } from "@mui/material";
import { getSession, listSessions } from "./api";
import { oldTodos, pickSuggestions, type Suggestion } from "./suggestions";

// How many of the newest sessions to look in for old todos.
const LOOK_IN = 8;

// A few clickable ideas under the empty chat's message: light starters, and
// steps left unfinished in past sessions' plans. Starters show at once; todos
// load in the background and join the mix once, so nothing waits on them.
// A click hands the text to the input box (onPick); it never sends.
export default function EmptyChatSuggestions({ onPick }: { onPick: (text: string) => void }) {
  const [todos, setTodos] = useState<Suggestion[] | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const rows = (await listSessions()).slice(0, LOOK_IN);
        // A session that fails to read is skipped, silently.
        const sessions = await Promise.all(
          rows.map((r) =>
            getSession(r.id)
              .then((s) => ({ title: r.userName || r.modelName || r.title, plan: s.plan }))
              .catch(() => null),
          ),
        );
        if (live) setTodos(oldTodos(sessions.filter((s) => s !== null)));
      } catch {
        // No todos; the starters stay.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Picked again only when the todos arrive, so the list doesn't reshuffle after that.
  const picks = useMemo(() => pickSuggestions(todos ?? []), [todos]);

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
        // On a short screen two are enough, so they stay clear of the message box.
        "@media (max-height: 640px)": { "& > :nth-of-type(n+3)": { display: "none" } },
      }}
    >
      {picks.map((s) => (
        <ButtonBase
          key={s.text}
          onClick={() => onPick(s.text)}
          sx={{
            maxWidth: "100%",
            px: 1.5,
            py: 0.75,
            borderRadius: 2,
            border: 1,
            borderColor: "divider",
            flexDirection: "column",
            alignItems: "center",
            "&:hover": { bgcolor: "action.hover" },
            "&.Mui-focusVisible": { outline: 2, outlineStyle: "solid", outlineColor: "primary.main" },
          }}
        >
          <Typography variant="body2" noWrap sx={{ maxWidth: "100%" }}>
            {s.text}
          </Typography>
          {s.from && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: "100%" }}>
              {s.from}
            </Typography>
          )}
        </ButtonBase>
      ))}
    </Box>
  );
}
