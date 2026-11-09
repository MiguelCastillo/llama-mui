// PlanView: the plan as a checklist. Steps can be edited, removed and rerun
// while the plan isn't running, and a disputed or failed step accepted as done.
// A step that has run can be opened to see its turns (the "Do step" message,
// the reply, its tool calls), which the chat itself doesn't show; `details`
// draws them, or returns null for a step with none. Each step is drawn by
// PlanStepRow.

import { type ReactNode, useState } from "react";
import {
  Box,
  Button,
  Collapse,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import WorktreeLines from "./WorktreeLines";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { type PlanStep } from "./api";
import { stepLine } from "./agent/plan";
import MarkdownRenderer from "./MarkdownRenderer";
import { PanelAction } from "./Panel";
import { PlanStepRow, type StepEdit } from "./PlanStepRow";

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
  onPause,
  result,
  where,
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
  // Pause, while the plan runs: ends the run at once, even mid-step. The plan
  // stays, the step in flight goes back to pending, and Continue picks it up.
  onPause?: () => void;
  // The plan's result: the model's last words once every step is done. Shown
  // under the checkmarks, open, as text you can select and copy; it ends with
  // the follow-up (see LAST_STEP_NOTE in agent/plan.ts).
  result?: string | null;
  // Where the work lives (worktreeLines), under the result; room for a merge button later.
  where?: string[];
}) {
  // Once every step is done, nothing in the plan runs again: no rerun, edit
  // or cancel. Redoing work is a new plan, from a new message.
  const readOnly = !onChange || steps.every((s) => s.status === "done");
  const [editing, setEditing] = useState<StepEdit | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [contextOpen, setContextOpen] = useState(false);
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const done = steps.filter((s) => s.status === "done").length;
  // A disputed step waits for the user, so Run would only stop on it again.
  // A waiting step (a question for the user) reruns without an answer on
  // Continue; "Answer and continue" on the step passes one.
  const next = steps.find((s) => s.status !== "done");
  const unfinished =
    next?.status === "pending" ||
    next?.status === "failed" ||
    next?.status === "waiting";
  // A step that was stopped or interrupted by a restart is back to pending with
  // a note saying so: the plan has started, so the button says Continue.
  const started = steps.some((s) => s.status !== "pending" || !!s.note);
  // Which buttons the bottom row shows.
  const showRun = !!(unfinished && onRun && !running);
  const showPause = !!(running && onPause);
  const showClone = !!(onClone && readOnly);
  const showDiscard = !!(onCancel && !readOnly && !running);

  const save = () => {
    if (!editing) return;
    const text = editing.text.trim();
    const summary = editing.summary.trim();
    // Without text there is nothing to run, so the edit is dropped. An empty
    // summary is allowed: the step then shows the start of its text.
    if (text) {
      onChange?.(
        steps.map((s, j) =>
          j === editing.i
            ? {
                id: s.id,
                text,
                ...(summary ? { summary } : {}),
                status: "pending",
              }
            : s,
        ),
      );
    }
    setEditing(null);
  };

  return (
    // One column, so every part (summary, header, steps, buttons, result,
    // proposal) sits the same distance from the next.
    <Paper variant="outlined" sx={{ px: 2, py: 1.5 }}>
      <Stack spacing={1.5}>
        {summary && (
          <Typography variant="body1" color="text.secondary">
            {summary}
          </Typography>
        )}
        {context && (
          <Box>
            <Button
              size="small"
              color="inherit"
              aria-expanded={contextOpen}
              onClick={() => setContextOpen((o) => !o)}
              endIcon={
                <ExpandMoreIcon
                  sx={{
                    transform: contextOpen ? "rotate(180deg)" : "none",
                    transition: "transform 0.15s",
                  }}
                />
              }
              sx={{
                ml: -0.75,
                color: "text.secondary",
                textTransform: "none",
                typography: "body1",
              }}
            >
              Context
            </Button>
            <Collapse in={contextOpen} unmountOnExit>
              <Typography
                variant="body1"
                color="text.secondary"
                sx={{
                  whiteSpace: "pre-wrap",
                  mt: 0.5,
                  pl: 1.5,
                  borderLeft: 2,
                  borderColor: "divider",
                }}
              >
                {context}
              </Typography>
            </Collapse>
          </Box>
        )}
        <Box>
          <Stack direction="row" sx={{ alignItems: "center", mb: 0.75 }}>
            <Typography
              variant="subtitle1"
              component="h3"
              sx={{ flexGrow: 1, fontWeight: 700 }}
            >
              Plan · {done} of {steps.length} done
              {/* The steps' times added up; with one timed step it would repeat that step's time. */}
              {steps.filter((s) => s.ms != null).length > 1 &&
                ` · ${formatTime(steps.reduce((sum, s) => sum + (s.ms ?? 0), 0))}`}
            </Typography>
            {since != null && counter && <Box>{counter(since)}</Box>}
          </Stack>
          <LinearProgress
            variant="determinate"
            value={steps.length ? (done / steps.length) * 100 : 0}
            aria-label="Plan progress"
            sx={{ height: "0.375rem", borderRadius: 1 }}
          />
        </Box>
        <Stack spacing={0.5}>
          {steps.map((s, i) => (
            <PlanStepRow
              key={s.id}
              step={s}
              index={i}
              steps={steps}
              running={running}
              readOnly={readOnly}
              editing={editing}
              onEditing={setEditing}
              onSave={save}
              open={open.has(s.id)}
              onToggle={() => toggle(s.id)}
              onChange={onChange}
              onRun={onRun}
              details={details}
              prompt={prompt}
              formatTime={formatTime}
            />
          ))}
        </Stack>
        {/* The plan's actions are buttons at the bottom, as in the approval
          prompts: the main one filled (Run), the rest outlined (Pause, Clone,
          Discard). Removing the plan is for a plan that isn't running: pause it first. */}
        {(showRun || showPause || showClone || showDiscard) && (
          <Stack direction="row" spacing={1}>
            {showRun && (
              <PanelAction
                label={started ? "Continue" : "Run"}
                variant="contained"
                color="primary"
                onClick={onRun}
              />
            )}
            {showPause && (
              <PanelAction
                label="Pause"
                variant="outlined"
                color="inherit"
                title="Pause: ends the run now and keeps the plan"
                onClick={onPause}
              />
            )}
            {showClone && (
              <PanelAction
                label="Clone"
                variant="outlined"
                color="inherit"
                title="Clone: a new plan with the same steps"
                onClick={onClone}
              />
            )}
            {showDiscard && (
              <PanelAction
                label="Discard"
                variant="outlined"
                color="inherit"
                onClick={onCancel}
              />
            )}
          </Stack>
        )}
        {result && steps.every((s) => s.status === "done") && (
          <Box
            sx={{
              pt: 1.5,
              borderTop: 1,
              borderColor: "divider",
              userSelect: "text",
            }}
          >
            <Typography
              variant="subtitle1"
              component="h3"
              sx={{ fontWeight: 700, mb: 0.75 }}
            >
              Result
            </Typography>
            <MarkdownRenderer content={result} />
            <Box sx={{ mx: -1, mt: 0.5 }}>
              <WorktreeLines lines={where ?? []} />
            </Box>
          </Box>
        )}
        {proposal && onProposal && (
          <ProposalView
            steps={steps}
            proposal={proposal}
            onAnswer={onProposal}
          />
        )}
      </Stack>
    </Paper>
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
    <Box sx={{ pt: 1.5, borderTop: 1, borderColor: "divider" }}>
      <Typography variant="body1" sx={{ mb: 0.5, fontWeight: 500 }}>
        Llama suggests a change to the plan
      </Typography>
      <Stack spacing={0.25} sx={{ mb: 1 }}>
        {proposal.map((s, i) => (
          <Typography
            key={s.id}
            variant="body1"
            color={old.has(s.text) ? "text.secondary" : "success.main"}
          >
            {old.has(s.text) ? " " : "+"} {i + 1}. {stepLine(s)}
          </Typography>
        ))}
        {removed.map((s) => (
          <Typography
            key={s.id}
            variant="body1"
            color="error.main"
            sx={{ textDecoration: "line-through" }}
          >
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
