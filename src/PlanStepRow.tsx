// PlanStepRow: one step of the plan card: status icon, title, notes, the answer
// form of a waiting step, the hover actions, and the details that unfold under
// it. PlanView owns the state (which step is being edited, which are open) and
// passes it in.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Box, Button, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { PanelButton, PanelToolbar, revealToolbarSx } from "./Panel";
import ReplayOutlinedIcon from "@mui/icons-material/ReplayOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import MarkDoneIcon from "@mui/icons-material/Done";
import { StatusIcon } from "./StatusMark";
import { type PlanStep } from "./api";
import { canMarkDone, stepLine } from "./agent/plan";

export type StepEdit = { i: number; text: string; summary: string };

// The looks come from StatusIcon. A disputed step and a waiting one both need
// the user, so they share a look. The spinner is 1rem with a small margin, so
// it takes the same room as an icon at fontSize small and rows don't shift.
const STATUS_ICON: Record<PlanStep["status"], ReactNode> = {
  pending: <StatusIcon kind="pending" fontSize="small" />,
  running: <StatusIcon kind="running" fontSize="small" sx={{ fontSize: "1rem", m: "0.125rem" }} />,
  done: <StatusIcon kind="done" fontSize="small" />,
  failed: <StatusIcon kind="failed" fontSize="small" />,
  disputed: <StatusIcon kind="needsYou" fontSize="small" />,
  waiting: <StatusIcon kind="needsYou" fontSize="small" />,
};

// A step put back to pending, keeping its id and its summary (the summary key
// is left out when there is none, so old plans stay as they were).
export const pending = (s: PlanStep, patch: Partial<PlanStep> = {}): PlanStep => ({
  id: s.id,
  text: s.text,
  ...(s.summary ? { summary: s.summary } : {}),
  status: "pending",
  ...patch,
});

export function PlanStepRow({
  step: s,
  index: i,
  steps,
  running,
  readOnly,
  editing,
  onEditing,
  onSave,
  open,
  onToggle,
  onChange,
  onRun,
  details,
  prompt,
  formatTime,
}: {
  step: PlanStep;
  // Its place in `steps`, which is the whole plan (changes are made on it).
  index: number;
  steps: PlanStep[];
  running?: boolean;
  readOnly: boolean;
  // The edit in progress, on any step of the plan: this row shows the fields
  // when it is on this step. `onSave` ends it, `onEditing(null)` drops it.
  editing: StepEdit | null;
  onEditing: (edit: StepEdit | null) => void;
  onSave: () => void;
  // Whether the details are unfolded.
  open: boolean;
  onToggle: () => void;
  onChange?: (steps: PlanStep[]) => void;
  onRun?: () => void;
  details: (stepId: string) => ReactNode[] | null;
  // A question for the user from the running step, shown under it.
  prompt?: ReactNode;
  formatTime: (ms: number) => string;
}) {
  const turns = details(s.id);
  // Nothing to unfold when the line already is the whole text (tidied, as stepLine does).
  const instruction = stepLine(s) !== s.text.replace(/\s+/g, " ").trim() ? s.text : null;
  const expandable = !!turns || !!instruction;

  // Rerunning a step leaves the ones after it done, but built on the old version.
  const rerun = () =>
    onChange?.(
      steps.map((st, j) =>
        j === i
          ? pending(st)
          : j > i && st.status === "done"
            ? { ...st, stale: true }
            : st,
      ),
    );

  return (
    <Box>
      <Box
        // The whole row opens and closes the details; clicks on its buttons and
        // fields are theirs, and so is a click that ends a text selection.
        onClick={(e) => {
          if (!expandable || editing?.i === i) return;
          if ((e.target as HTMLElement).closest("button, input, textarea, a, label")) return;
          if (window.getSelection()?.toString()) return;
          onToggle();
        }}
        onKeyDown={(e) => {
          if (!expandable || e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        sx={{
          position: "relative",
          display: "flex",
          gap: 1,
          alignItems: "flex-start",
          cursor: expandable ? "pointer" : undefined,
          ...revealToolbarSx,
        }}
      >
        <Box sx={{ pt: 0.25 }}>{STATUS_ICON[s.status]}</Box>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          {editing?.i === i ? (
            // Two fields, so the edit ends only when focus leaves both.
            <Stack
              spacing={1}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onSave();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) onSave();
                if (e.key === "Escape") onEditing(null);
              }}
            >
              <TextField
                size="small"
                fullWidth
                autoFocus
                label="Summary"
                placeholder={stepLine({ text: editing.text })}
                value={editing.summary}
                onChange={(e) => onEditing({ ...editing, summary: e.target.value })}
              />
              <TextField
                size="small"
                fullWidth
                multiline
                label="Instruction"
                value={editing.text}
                onChange={(e) => onEditing({ ...editing, text: e.target.value })}
              />
            </Stack>
          ) : (
            <>
              <Typography variant="body1">
                {i + 1}. {stepLine(s)}
                {/* Only a finished step has a time: running or rerunning it clears it. */}
                {s.ms != null && (
                  <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 1 }}>
                    {formatTime(s.ms)}
                  </Typography>
                )}
              </Typography>
            </>
          )}
          {s.status === "failed" && s.note && (
            <Typography variant="caption" color="error.main" component="div">
              Not done: {s.note}
            </Typography>
          )}
          {s.status === "disputed" && s.note && (
            <Typography variant="caption" color="warning.main" component="div">
              {s.note}
            </Typography>
          )}
          {s.status === "waiting" && s.note && (
            <Typography variant="caption" color="warning.main" component="div" sx={{ whiteSpace: "pre-wrap" }}>
              {s.note}
            </Typography>
          )}
          {s.status === "waiting" && !running && !readOnly && (
            <AnswerForm
              onAnswer={(answer) => {
                onChange?.(
                  steps.map((st, j) =>
                    j === i ? pending(st, { answer, asked: st.note }) : st,
                  ),
                );
                // changePlan updates the plan synchronously, so the run sees the answer.
                onRun?.();
              }}
            />
          )}
          {s.status === "pending" && s.note && (
            <Typography variant="caption" color="text.secondary" component="div">
              {s.note}
            </Typography>
          )}
          {s.stale && s.status === "done" && (
            <Typography variant="caption" color="warning.main" component="div">
              An earlier step changed; this may need a rerun.
            </Typography>
          )}
        </Box>
        {!running && !readOnly && (
          // Shown on hover so the list stays quiet.
          <PanelToolbar>
            {canMarkDone(s.status) && (
              <PanelButton
                label="The check is wrong: mark it done"
                icon={<MarkDoneIcon />}
                onClick={() => onChange?.(steps.map((st, j) => (j === i ? pending(st, { status: "done" }) : st)))}
              />
            )}
            {(s.status === "done" || s.status === "failed" || s.status === "disputed" || s.status === "waiting") && (
              <PanelButton label="Rerun this step" icon={<ReplayOutlinedIcon />} onClick={rerun} />
            )}
            <PanelButton
              label="Edit step"
              icon={<EditOutlinedIcon />}
              onClick={() => onEditing({ i, text: s.text, summary: s.summary ?? "" })}
            />
            <PanelButton
              label="Remove step"
              icon={<DeleteOutlinedIcon />}
              onClick={() => onChange?.(steps.filter((_, j) => j !== i))}
            />
          </PanelToolbar>
        )}
        {expandable && (
          // Only shows the state: the row itself is what opens and closes it.
          <Tooltip title={open ? "Hide details" : "Show the full instruction and what happened"}>
            <Box sx={{ display: "flex", flexShrink: 0, color: "action.active" }}>
              {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </Box>
          </Tooltip>
        )}
      </Box>
      {s.status === "running" && prompt && <InView>{prompt}</InView>}
      {expandable && open && (
        <Stack spacing={1} sx={{ ml: 3.5, mt: 1, mb: 1.5, pl: 1.5, borderLeft: 2, borderColor: "divider" }}>
          {instruction && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ whiteSpace: "pre-wrap" }}>
              {instruction}
            </Typography>
          )}
          {turns}
        </Stack>
      )}
    </Box>
  );
}

// The user's answer to a waiting step's question. The text is local state, so
// typing doesn't change the plan until "Answer and continue".
function AnswerForm({ onAnswer }: { onAnswer: (answer: string) => void }) {
  const [text, setText] = useState("");
  const answer = text.trim();
  return (
    <Stack
      direction="row"
      spacing={1}
      // The form is not part of the row that opens the details.
      onClick={(e) => e.stopPropagation()}
      sx={{ mt: 0.75, alignItems: "flex-start", cursor: "auto" }}
    >
      <TextField
        size="small"
        fullWidth
        multiline
        maxRows={4}
        label="Your answer"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button
        size="small"
        variant="contained"
        disabled={!answer}
        onClick={() => onAnswer(answer)}
        sx={{ flexShrink: 0, whiteSpace: "nowrap", mt: 0.5 }}
      >
        Answer and continue
      </Button>
    </Stack>
  );
}

// Scrolls its content into view once, when it appears: a step's prompt may
// show above what's on screen, in a plan card higher up the chat.
function InView({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Braces: scrollIntoView returns a Promise in newer browsers, and an effect
  // that returns one crashes React when it cleans up.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <Box ref={ref} sx={{ ml: 3.5, mt: 1, mb: 1.5 }}>
      {children}
    </Box>
  );
}
