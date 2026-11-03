// PlanView: the plan as a checklist. Steps can be edited, removed and rerun
// while the plan isn't running, and a disputed step accepted as done.
// A step that has run can be opened to see its turns (the "Do step" message,
// the reply, its tool calls), which the chat itself doesn't show; `details`
// draws them, or returns null for a step with none.

import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import ReplayOutlinedIcon from "@mui/icons-material/ReplayOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import DoneIcon from "@mui/icons-material/Done";
import { type PlanStep } from "./api";
import { stepLine } from "./agent/plan";

const STATUS_ICON: Record<PlanStep["status"], ReactNode> = {
  pending: <RadioButtonUncheckedIcon fontSize="small" color="disabled" />,
  running: <CircularProgress size={16} sx={{ m: "2px" }} />,
  done: <CheckCircleIcon fontSize="small" color="success" />,
  failed: <CancelIcon fontSize="small" color="error" />,
  disputed: <HelpOutlineIcon fontSize="small" color="warning" />,
  waiting: <HelpOutlineIcon fontSize="small" color="warning" />,
};

// A step put back to pending, keeping its id and its summary (the summary key
// is left out when there is none, so old plans stay as they were).
const pending = (s: PlanStep, patch: Partial<PlanStep> = {}): PlanStep => ({
  id: s.id,
  text: s.text,
  ...(s.summary ? { summary: s.summary } : {}),
  status: "pending",
  ...patch,
});

export function PlanView({
  steps,
  summary,
  context,
  running,
  onRun,
  onChange,
  details,
  since,
  counter,
  proposal,
  onProposal,
  formatTime,
  onCancel,
  onClone,
  prompt,
  control,
  onPause,
  onResume,
}: {
  steps: PlanStep[];
  // One short sentence the model wrote on what this plan does; shown at the top.
  summary?: string | null;
  // Context the model wrote for this plan, describing what the steps need
  // from the conversation. Shown collapsed by default.
  context?: string | null;
  // An older finished plan passes none of running, onRun, onChange and
  // onCancel. Any finished plan is read-only (see `readOnly`).
  running?: boolean;
  onRun?: () => void;
  onChange?: (steps: PlanStep[]) => void;
  details: (stepId: string) => ReactNode[] | null;
  // While the plan runs: when the run started, for the elapsed counter.
  since?: number | null;
  // Draws that counter; passed in so the plan shares chat's.
  counter?: (since: number) => ReactNode;
  // A change the model suggested (see Chat.tsx), and the user's answer to it.
  proposal?: PlanStep[] | null;
  onProposal?: (accept: boolean) => void;
  // Formats a step's time like chat's reply times; passed in, like `counter`.
  formatTime: (ms: number) => string;
  // Asks to cancel the plan: chat confirms, stops a run, and removes it.
  onCancel?: () => void;
  // Starts a new plan with a finished plan's steps; absent when it can't
  // (see Chat.tsx). A finished plan never runs again, so this is how to redo it.
  onClone?: () => void;
  // A question for the user from the running step (approve a change, allow a
  // folder), shown under that step: at the bottom of the chat, it meant
  // scrolling between it and the plan's progress.
  prompt?: ReactNode;
  // The Pause control while the plan runs (see pauseControl in runView.ts): a
  // short caption, and the button, if any. `running` stays true while paused,
  // so the steps stay uneditable.
  control?: { text: string | null; button: "Pause" | "Resume" | null };
  onPause?: () => void;
  onResume?: () => void;
}) {
  // Once every step is done, nothing in the plan runs again: no rerun, edit
  // or cancel. Redoing work is a new plan, from a new message.
  const readOnly = !onChange || steps.every((s) => s.status === "done");
  const [editing, setEditing] = useState<{ i: number; text: string; summary: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Steps whose instruction is shown under "Details"; collapsed by default.
  const [shown, setShown] = useState<Set<string>>(new Set());
  const toggleShown = (id: string) =>
    setShown((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const done = steps.filter((s) => s.status === "done").length;
  // A disputed step waits for the user, so Run would only stop on it again.
  // A waiting step (a question for the user) reruns without an answer on
  // Continue; "Answer and continue" on the step passes one.
  const next = steps.find((s) => s.status !== "done");
  const unfinished = next?.status === "pending" || next?.status === "failed" || next?.status === "waiting";
  // A step that was stopped or interrupted by a restart is back to pending with
  // a note saying so: the plan has started, so the button says Continue.
  const started = steps.some((s) => s.status !== "pending" || !!s.note);

  // Rerunning a step leaves the ones after it done, but built on the old version.
  const rerun = (i: number) =>
    onChange?.(
      steps.map((s, j) =>
        j === i
          ? pending(s)
          : j > i && s.status === "done"
            ? { ...s, stale: true }
            : s,
      ),
    );
  const save = () => {
    if (!editing) return;
    const text = editing.text.trim();
    const summary = editing.summary.trim();
    // Without text there is nothing to run, so the edit is dropped. An empty
    // summary is allowed: the step then shows the start of its text.
    if (text) {
      onChange?.(
        steps.map((s, j) =>
          j === editing.i ? { id: s.id, text, ...(summary ? { summary } : {}), status: "pending" } : s,
        ),
      );
    }
    setEditing(null);
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      {summary && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {summary}
        </Typography>
      )}
      {context && (
        <Accordion elevation={0} sx={{ bgcolor: "action.hover", "&:before": { display: "none" } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="caption" color="text.secondary">
              Context
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ pt: 0.75 }}>
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
              {context}
            </Typography>
          </AccordionDetails>
        </Accordion>
      )}
      <Stack direction="row" sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Plan · {done} of {steps.length} done
        </Typography>
        {control?.text && (
          <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
            {control.text}
          </Typography>
        )}
        {since != null && counter && <Box sx={{ mr: 1 }}>{counter(since)}</Box>}
        {control?.button === "Pause" && onPause && (
          <Button size="small" onClick={onPause} sx={{ mr: 1 }}>
            Pause
          </Button>
        )}
        {control?.button === "Resume" && onResume && (
          <Button size="small" onClick={onResume} sx={{ mr: 1 }}>
            Resume
          </Button>
        )}
        {/* Also while it runs: chat stops it first, then removes the plan. */}
        {onClone && readOnly && (
          <Button size="small" onClick={onClone}>
            Clone
          </Button>
        )}
        {onCancel && !readOnly && (
          <Button size="small" onClick={onCancel} sx={{ mr: unfinished ? 1 : 0 }}>
            Cancel plan
          </Button>
        )}
        {unfinished && onRun && (
          <Button size="small" variant="contained" startIcon={<PlayArrowIcon />} onClick={onRun} disabled={running}>
            {started ? "Continue" : "Run"}
          </Button>
        )}
      </Stack>
      <Stack spacing={0.5}>
        {steps.map((s, i) => {
          const turns = details(s.id);
          return (
            <Box key={s.id}>
              <Box
                sx={{
                  display: "flex",
                  gap: 1,
                  alignItems: "flex-start",
                  "&:hover .step-actions": { visibility: "visible" },
                }}
              >
                <Box sx={{ pt: 0.25 }}>{STATUS_ICON[s.status]}</Box>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  {editing?.i === i ? (
                    // Two fields, so the edit ends only when focus leaves both.
                    <Stack
                      spacing={1}
                      onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) save();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) save();
                        if (e.key === "Escape") setEditing(null);
                      }}
                    >
                      <TextField
                        size="small"
                        fullWidth
                        autoFocus
                        label="Summary"
                        placeholder={stepLine({ text: editing.text })}
                        value={editing.summary}
                        onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
                      />
                      <TextField
                        size="small"
                        fullWidth
                        multiline
                        label="Instruction"
                        value={editing.text}
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      />
                    </Stack>
                  ) : (
                    <>
                      <Typography variant="body2">
                        {i + 1}. {stepLine(s)}
                      </Typography>
                      {/* Nothing to unfold when the line already is the whole text (tidied, as stepLine does). */}
                      {stepLine(s) !== s.text.replace(/\s+/g, " ").trim() && (
                        <>
                          <Box
                            component="button"
                            type="button"
                            onClick={() => toggleShown(s.id)}
                            aria-expanded={shown.has(s.id)}
                            sx={{
                              display: "inline-flex",
                              alignItems: "center",
                              p: 0,
                              border: 0,
                              bgcolor: "transparent",
                              color: "text.secondary",
                              cursor: "pointer",
                              font: "inherit",
                              fontSize: "0.75rem",
                            }}
                          >
                            {shown.has(s.id) ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
                            Details
                          </Box>
                          {shown.has(s.id) && (
                            <Typography variant="caption" color="text.secondary" component="div" sx={{ whiteSpace: "pre-wrap" }}>
                              {s.text}
                            </Typography>
                          )}
                        </>
                      )}
                    </>
                  )}
                  {/* Only a finished step has a time: running or rerunning it clears it. */}
                  {s.ms != null && (
                    <Typography variant="caption" color="text.secondary" component="div">
                      {formatTime(s.ms)}
                    </Typography>
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
                  <Box className="step-actions" sx={{ visibility: "hidden", display: "flex", flexShrink: 0 }}>
                    {s.status === "disputed" && (
                      <Tooltip title="The check is wrong: mark it done">
                        <IconButton
                          size="small"
                          onClick={() => onChange?.(steps.map((st, j) => (j === i ? pending(st, { status: "done" }) : st)))}
                        >
                          <DoneIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {(s.status === "done" || s.status === "failed" || s.status === "disputed" || s.status === "waiting") && (
                      <Tooltip title="Rerun this step">
                        <IconButton size="small" onClick={() => rerun(i)}>
                          <ReplayOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title="Edit step">
                      <IconButton size="small" onClick={() => setEditing({ i, text: s.text, summary: s.summary ?? "" })}>
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Remove step">
                      <IconButton size="small" onClick={() => onChange?.(steps.filter((_, j) => j !== i))}>
                        <DeleteOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                )}
                {turns && (
                  <Tooltip title={open.has(s.id) ? "Hide what happened" : "Show what happened"}>
                    <IconButton size="small" onClick={() => toggle(s.id)} aria-expanded={open.has(s.id)}>
                      {open.has(s.id) ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
              {s.status === "running" && prompt && <InView>{prompt}</InView>}
              {turns && open.has(s.id) && (
                <Stack spacing={1} sx={{ ml: 3.5, mt: 1, mb: 1.5, pl: 1.5, borderLeft: 2, borderColor: "divider" }}>
                  {turns}
                </Stack>
              )}
            </Box>
          );
        })}
      </Stack>
      {steps.some((s) => s.ms != null) && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, textAlign: "right" }}>
          Total {formatTime(steps.reduce((sum, s) => sum + (s.ms ?? 0), 0))}
        </Typography>
      )}
      {proposal && onProposal && <ProposalView steps={steps} proposal={proposal} onAnswer={onProposal} />}
    </Paper>
  );
}

// The user's answer to a waiting step's question. The text is local state, so
// typing doesn't change the plan until "Answer and continue".
function AnswerForm({ onAnswer }: { onAnswer: (answer: string) => void }) {
  const [text, setText] = useState("");
  const answer = text.trim();
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 0.75, alignItems: "flex-start" }}>
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

// A suggested plan change as a diff of steps (by text, shown by summary): removed steps struck out,
// new ones marked. Kept steps keep their status when it's accepted.
function ProposalView({
  steps,
  proposal,
  onAnswer,
}: {
  steps: PlanStep[];
  proposal: PlanStep[];
  onAnswer: (accept: boolean) => void;
}) {
  const kept = new Set(proposal.map((s) => s.text));
  const old = new Set(steps.map((s) => s.text));
  const removed = steps.filter((s) => !kept.has(s.text));
  return (
    <Box sx={{ mt: 1.5, pt: 1.5, borderTop: 1, borderColor: "divider" }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Llama suggests a change to the plan
      </Typography>
      <Stack spacing={0.25} sx={{ mb: 1 }}>
        {proposal.map((s, i) => (
          <Typography key={s.id} variant="body2" color={old.has(s.text) ? "text.secondary" : "success.main"}>
            {old.has(s.text) ? " " : "+"} {i + 1}. {stepLine(s)}
          </Typography>
        ))}
        {removed.map((s) => (
          <Typography key={s.id} variant="body2" color="error.main" sx={{ textDecoration: "line-through" }}>
            − {stepLine(s)}
          </Typography>
        ))}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        <Button size="small" onClick={() => onAnswer(false)}>
          Keep the plan
        </Button>
        <Button size="small" variant="contained" onClick={() => onAnswer(true)}>
          Use this plan
        </Button>
      </Stack>
    </Box>
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
