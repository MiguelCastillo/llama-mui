// Plans: the steps of a task, from the model's update_plan calls. Small models
// say they're done when they aren't, so chat runs a plan one step per turn and
// checks each step with reviewStep before ticking it off.

import { type ReactNode, useState } from "react";
import { Box, Button, CircularProgress, IconButton, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import ReplayOutlinedIcon from "@mui/icons-material/ReplayOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { type ChatMessage, type PlanStep, streamChat } from "./api";

// With Plan on, a new message first gets a planning turn: the model can only
// read and call update_plan, so it writes the plan instead of starting on the
// work. Small models skip the plan when it's only suggested.
export const PLANNING_TOOLS = new Set([
  "update_plan",
  "list_directory",
  "read_file",
  "find_files",
  "grep",
  "locate_path",
]);
export const PLANNING_NOTE =
  "Right now, only plan. Read what you need, then call update_plan with the steps for this request, all " +
  "pending, and stop. Don't change any files yet: the user reviews the plan and runs it. If the request " +
  "doesn't change files, answer it directly instead.";

// The plan from an update_plan call's arguments. Statuses other than done
// start pending: running and failed are chat's to set. `ids` keeps the ids of
// steps that already exist, by position, so their messages stay with them.
export function planFromCall(args: string, ids: string[] = []): PlanStep[] | null {
  try {
    const steps = JSON.parse(args).steps;
    if (!Array.isArray(steps)) return null;
    return steps.map((s: any, i: number) => ({
      id: ids[i] ?? crypto.randomUUID(),
      text: String(typeof s === "string" ? s : s.text).trim(),
      status: s?.status === "done" ? "done" : "pending",
    }));
  } catch {
    return null;
  }
}

// The message that runs step i: just that step, with the plan for context.
export function stepPrompt(steps: PlanStep[], i: number): string {
  const list = steps.map((s, j) => `${s.status === "done" ? "[x]" : "[ ]"} ${j + 1}. ${s.text}`).join("\n");
  return `Do step ${i + 1} of ${steps.length}: ${steps[i].text}\n\nThe plan:\n${list}`;
}

const MAX_CHANGE_CHARS = 2000;
const MAX_CHANGES_CHARS = 8000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut)` : s);

// What a step changed, from its write and command calls and their results.
// An approved change uses the diff the user saw: its surrounding lines show
// what an edit left alone, like an old line next to the new one.
function changesIn(messages: ChatMessage[]): string {
  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m]));
  const parts: string[] = [];
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      if (!["write_file", "edit_file", "run_command"].includes(c.name)) continue;
      let a: any = {};
      try {
        a = JSON.parse(c.arguments);
      } catch {
        // Its result says the arguments were bad.
      }
      const result = results.get(c.id);
      const body = result?.diff
        ? `${c.name} ${a.path}\n${result.diff}`
        : c.name === "edit_file"
          ? `edit_file ${a.path}\nreplaced:\n${a.old_text}\nwith:\n${a.new_text}`
          : c.name === "write_file"
            ? `write_file ${a.path}\n${a.content}`
            : `run_command ${a.command}`;
      parts.push(clip(`${body}\nresult: ${result?.content ?? "(none)"}`, MAX_CHANGE_CHARS));
    }
  }
  return clip(parts.join("\n\n"), MAX_CHANGES_CHARS);
}

const REVIEW_PROMPT =
  "You check whether one step of a coding task was really done. You get the step, the changes made " +
  "during it, and the reply that claims it's done. Judge only this step, and only from the changes: a " +
  "claim with no change to back it up doesn't count. Answer with exactly one line: DONE, or MISSING: " +
  "followed by what's still missing. A step that only needed reading or checking is DONE if the reply " +
  "reports what it found.";

// Asks the model, with no tools, whether the step's changes do what the step
// says. `messages` is the step's turn: from its "Do step" message on.
export async function reviewStep(
  { connectorId, model, think }: { connectorId: string; model: string; think: boolean },
  step: string,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<{ done: boolean; missing?: string }> {
  const replyText = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "";
  let answer = "";
  await streamChat(
    {
      connectorId,
      model,
      think,
      messages: [
        { role: "system", content: REVIEW_PROMPT },
        {
          role: "user",
          content:
            `Step: ${step}\n\nChanges made during this step:\n${changesIn(messages) || "(no file changes)"}\n\n` +
            `The reply:\n${clip(replyText, MAX_CHANGE_CHARS) || "(empty)"}`,
        },
      ],
    },
    (d) => (answer += d.content ?? ""),
    signal,
  );
  const missing = answer.match(/MISSING:\s*(.+)/i);
  if (missing) return { done: false, missing: missing[1].trim() };
  if (/\bDONE\b/i.test(answer)) return { done: true };
  return { done: false, missing: `the check gave no clear answer: ${clip(answer.trim(), 200) || "(empty)"}` };
}

const STATUS_ICON: Record<PlanStep["status"], ReactNode> = {
  pending: <RadioButtonUncheckedIcon fontSize="small" color="disabled" />,
  running: <CircularProgress size={16} sx={{ m: "2px" }} />,
  done: <CheckCircleIcon fontSize="small" color="success" />,
  failed: <CancelIcon fontSize="small" color="error" />,
};

// The plan as a checklist. Steps can be edited, removed and rerun while the
// plan isn't running. A step that has run can be opened to see its turns
// (the "Do step" message, the reply, its tool calls), which the chat itself
// doesn't show; `details` draws them, or returns null for a step with none.
export function PlanView({
  steps,
  running,
  onRun,
  onChange,
  details,
}: {
  steps: PlanStep[];
  running: boolean;
  onRun: () => void;
  onChange: (steps: PlanStep[]) => void;
  details: (stepId: string) => ReactNode[] | null;
}) {
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const done = steps.filter((s) => s.status === "done").length;
  const unfinished = steps.some((s) => s.status === "pending" || s.status === "failed");
  const started = steps.some((s) => s.status !== "pending");

  // Rerunning a step leaves the ones after it done, but built on the old version.
  const rerun = (i: number) =>
    onChange(
      steps.map((s, j) =>
        j === i
          ? { id: s.id, text: s.text, status: "pending" }
          : j > i && s.status === "done"
            ? { ...s, stale: true }
            : s,
      ),
    );
  const save = () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (text) onChange(steps.map((s, j) => (j === editing.i ? { id: s.id, text, status: "pending" } : s)));
    setEditing(null);
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Plan · {done} of {steps.length} done
        </Typography>
        {unfinished && (
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
                    <TextField
                      size="small"
                      fullWidth
                      autoFocus
                      value={editing.text}
                      onChange={(e) => setEditing({ i, text: e.target.value })}
                      onBlur={save}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save();
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <Typography variant="body2">
                      {i + 1}. {s.text}
                    </Typography>
                  )}
                  {s.status === "failed" && s.note && (
                    <Typography variant="caption" color="error.main" component="div">
                      Not done: {s.note}
                    </Typography>
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
                {!running && (
                  // Shown on hover so the list stays quiet.
                  <Box className="step-actions" sx={{ visibility: "hidden", display: "flex", flexShrink: 0 }}>
                    {(s.status === "done" || s.status === "failed") && (
                      <Tooltip title="Rerun this step">
                        <IconButton size="small" onClick={() => rerun(i)}>
                          <ReplayOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title="Edit step">
                      <IconButton size="small" onClick={() => setEditing({ i, text: s.text })}>
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Remove step">
                      <IconButton size="small" onClick={() => onChange(steps.filter((_, j) => j !== i))}>
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
              {turns && open.has(s.id) && (
                <Stack spacing={1} sx={{ ml: 3.5, mt: 1, mb: 1.5, pl: 1.5, borderLeft: 2, borderColor: "divider" }}>
                  {turns}
                </Stack>
              )}
            </Box>
          );
        })}
      </Stack>
    </Paper>
  );
}
