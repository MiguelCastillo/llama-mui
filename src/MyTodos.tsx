import { useEffect, useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import TodoRow from "./TodoRow";
import UndoNotice from "./UndoNotice";
import type { RemovedTodo } from "./api";

// How long "Removed: …" offers Undo.
export const UNDO_MS = 6000;
import { ago } from "./SessionsPanel";
import type { Start, TodoGroup } from "./todos";

// "My Todos…" under the empty chat's suggestions: opens every open todo from
// past sessions as a list of boxes, newest session first. A box starts that todo
// in its session (onStart: the chat opens the session, sets a context boundary
// and sends the todo). Its icon only opens the session; Done and Remove ask the
// server (onEdit) and the list follows its answer. Shows nothing when there are
// no groups, unless the dialog is already open.
export default function MyTodos({
  groups,
  onStart,
  onOpenSession,
  onEdit,
  onRestore,
  defaultOpen = false,
  defaultUndo,
  disablePortal = false,
}: {
  groups: TodoGroup[];
  onStart: (start: Start) => void;
  onOpenSession: (sessionId: string) => void;
  // Done or Remove on one todo: resolves once the server answered and the list
  // has been updated from that answer; rejects with a plain message.
  // For a Remove it resolves with what the server says it removed (so Undo can
  // send it back).
  onEdit: (sessionId: string, todoId: string, action: "done" | "remove") => Promise<RemovedTodo | void>;
  // Undo of a Remove: resolves once the list has been updated from the answer.
  onRestore: (sessionId: string, removed: RemovedTodo) => Promise<void>;
  defaultOpen?: boolean;
  // Only for tests: start with the Undo offer showing.
  defaultUndo?: { sessionId: string; removed: RemovedTodo };
  disablePortal?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  // The last Remove, offered for Undo until the timer runs out or the dialog closes.
  const [undo, setUndo] = useState<{ sessionId: string; removed: RemovedTodo } | null>(defaultUndo ?? null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | undefined>();
  useEffect(() => {
    if (!undo || undoBusy) return;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo, undoBusy]);
  // The dialog stays open while it's showing, even when the last todo is gone.
  if (!groups.length && !open && !undo) return null;
  const edit = async (sessionId: string, todoId: string, action: "done" | "remove") => {
    const key = `${sessionId}:${todoId}`;
    setBusy(key);
    setFailed(null);
    try {
      const removed = await onEdit(sessionId, todoId, action);
      if (action === "remove" && removed) {
        setUndo({ sessionId, removed });
        setUndoError(undefined);
      }
    } catch (e) {
      setFailed({ key, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const restore = async () => {
    if (!undo) return;
    setUndoBusy(true);
    try {
      await onRestore(undo.sessionId, undo.removed);
      setUndo(null);
    } catch (e) {
      setUndoError(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoBusy(false);
    }
  };
  // Closing the dialog drops the offer; nothing more happens.
  const close = () => {
    setOpen(false);
    setUndo(null);
    setUndoError(undefined);
  };
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
        disablePortal={disablePortal}
        fullWidth
        maxWidth="sm"
        scroll="paper"
        sx={{ "& .MuiDialog-paper": { mx: { xs: 1, sm: 4 }, width: { xs: "calc(100% - 1rem)", sm: undefined } } }}
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
              g.todos.map((todo) => {
                const key = `${g.sessionId}:${todo.id}`;
                return (
                  <TodoRow
                    key={key}
                    summary={todo.summary}
                    detail={`${g.title}${g.updatedAt ? ` · ${ago(g.updatedAt)}` : ""}`}
                    sessionTitle={g.title}
                    busy={busy === key}
                    error={failed?.key === key ? failed.message : undefined}
                    onStart={() => {
                      onStart({ sessionId: g.sessionId, todoId: todo.id, summary: todo.summary });
                      close();
                    }}
                    onOpenSession={() => {
                      onOpenSession(g.sessionId);
                      close();
                    }}
                    onDone={() => edit(g.sessionId, todo.id, "done")}
                    onRemove={() => edit(g.sessionId, todo.id, "remove")}
                  />
                );
              }),
            )}
          </Stack>
        </DialogContent>
        {undo ? <UndoNotice summary={undo.removed.todo.summary} busy={undoBusy} error={undoError} onUndo={restore} /> : null}
        <DialogActions>
          <Button onClick={close} color="inherit">
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
