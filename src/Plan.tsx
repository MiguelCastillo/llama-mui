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
import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import DoneIcon from "@mui/icons-material/Done";
import { type ChatMessage, type PlanStep, streamChat } from "./api";

// With Plan on, a new message first gets a planning turn: the model can only
// read and call update_plan, so it writes the plan instead of starting on the
// work. Small models skip the plan when it's only suggested. It still gets
// every tool, and chat refuses the rest when they're called: a different tool
// list, like a different system prompt, made llama.cpp reprocess the whole
// chat. PLANNING_NOTE goes with the message, as its `note`, for the same reason.
export const PLANNING_TOOLS = new Set([
  "update_plan",
  "list_directory",
  "read_file",
  "find_files",
  "grep",
  "locate_path",
]);
// A note: an instruction for one turn, sent after the message's text (see
// README, "What the model is told"). A question comes first: led by "only
// plan", the model opened its answers to questions with "This is a question,
// not a file change request", replying to a note the user never sees.
export const PLANNING_NOTE =
  "If this message is a question or otherwise doesn't change files, just answer it, and don't mention plans. " +
  "If it asks for changes to files, only plan for now: read what you need, then call update_plan with the " +
  "steps, and stop. Don't change any files yet: the user reviews the plan and runs it.";

// The plan from an update_plan call's arguments, merged with the plan so far.
// Only chat's check ticks a step off, so a step keeps its id, status and note
// only if it's the same step as before, and otherwise starts pending: while
// the plan runs, the step in the same position (the model may reword the step
// it's on); otherwise, the step with the same text. See README, "How plans work".
export function planFromCall(args: string, old: PlanStep[], running: boolean): PlanStep[] | null {
  try {
    const steps = JSON.parse(args).steps;
    if (!Array.isArray(steps)) return null;
    return steps.map((s: any, i: number) => {
      const text = String(typeof s === "string" ? s : s.text).trim();
      const same = running ? old[i] : old.find((o) => o.text === text);
      return same ? { ...same, text } : { id: crypto.randomUUID(), text, status: "pending" };
    });
  } catch {
    return null;
  }
}

// The message that runs step i: just that step, with the plan for context.
export function stepPrompt(steps: PlanStep[], i: number): string {
  const list = steps.map((s, j) => `${s.status === "done" ? "[x]" : "[ ]"} ${j + 1}. ${s.text}`).join("\n");
  return `Do step ${i + 1} of ${steps.length}: ${steps[i].text}\n\nThe plan:\n${list}`;
}

// Room for a new file of a few hundred lines: a step that writes one is judged
// on all of it, and a clipped file can't be checked at all.
const MAX_CHANGE_CHARS = 12000;
const MAX_CHANGES_CHARS = 24000;
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

// The files a step wrote or edited, each once.
export function filesChanged(messages: ChatMessage[]): string[] {
  const ok = new Set(
    messages.filter((m) => m.role === "tool" && !m.content.startsWith("Error:")).map((m) => m.toolCallId),
  );
  const paths = messages.flatMap((m) =>
    (m.toolCalls ?? []).flatMap((c) => {
      if (!["write_file", "edit_file"].includes(c.name) || !ok.has(c.id)) return [];
      try {
        return [String(JSON.parse(c.arguments).path)];
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(paths)];
}

// A file as the check reads it: its text now, or why it couldn't be read.
// `cut`: read_file stopped short, so it's too big however much room there is.
export type WholeFile = { path: string; text: string; cut?: boolean } | { path: string; error: string };

// The check judges the step's files whole, as they are now, not just the
// diffs. Diff hunks hide the lines around a change (a parameter looked
// undefined because its signature wasn't in the hunk), and a rerun's changes
// are only its fixes, so what an earlier attempt wrote looked missing.
// Room for the files: half the model's context, at about 4 characters a
// token; the rest is for the diffs, the prompt and the answer. Files that
// don't fit stop the step instead of being cut or swapped for the diffs: a
// check that can't see the code guesses, and its guess looks like a verdict.
const tokens = (chars: number) => Math.ceil(chars / 4);
export const checkRoom = (contextSize?: number) => Math.floor((contextSize ?? 32000) / 2) * 4;

// Why the check can't judge these files, or null if it can.
function uncheckable(files: WholeFile[], room: number): string | null {
  const unread = files.find((f) => "error" in f);
  if (unread && "error" in unread) return `Couldn't check this step: couldn't read ${unread.path} (${unread.error}).`;
  const size = files.reduce((n, f) => n + ("text" in f ? f.text.length : 0), 0);
  if (size <= room && !files.some((f) => "cut" in f && f.cut)) return null;
  const list = files.map((f) => `${f.path} (~${"text" in f ? tokens(f.text.length) : "?"} tokens)`).join(", ");
  return (
    `Couldn't check this step: ${list} ${files.length > 1 ? "are" : "is"} too big for the check, which has ` +
    `room for ~${tokens(room)} tokens of files (half of the model's context).`
  );
}

const REVIEW_PROMPT =
  "You check whether one step of a coding task was really done. You get the step, the files it " +
  "changed as they are now, the changes made during it, and the reply that claims it's done. Judge " +
  "only this step, from the files: code that's in them counts, even if an earlier attempt wrote it, " +
  "and a claim the files don't back up doesn't. Answer with exactly one line: DONE, or MISSING: " +
  "followed by what's still missing. A step that only needed reading or checking is DONE if the reply " +
  "reports what it found.";

// Asks the model, with no tools, whether the step's files do what the step
// says. `messages` is the step's turn: from its "Do step" message on;
// `files` are filesChanged(messages) read now. `unchecked` says why it
// couldn't judge them; the model isn't asked then.
export async function reviewStep(
  { connectorId, model, think, room }: { connectorId: string; model: string; think: boolean; room: number },
  step: string,
  messages: ChatMessage[],
  files: WholeFile[],
  signal: AbortSignal,
): Promise<{ done: boolean; missing?: string; unchecked?: string }> {
  const unchecked = uncheckable(files, room);
  if (unchecked) return { done: false, unchecked };
  const whole = files.map((f) => ("text" in f ? `=== ${f.path}\n${f.text}` : "")).join("\n\n");
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
            `Step: ${step}\n\nThe files it changed, as they are now:\n${whole || "(none)"}\n\n` +
            `Changes made during this step:\n${changesIn(messages) || "(no file changes)"}\n\n` +
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

// The retry after a failed check. The check is a model too and can be wrong,
// and a small model told it failed agrees and "fixes" what isn't broken (it
// said a parameter was undefined, renamed nothing and claimed a fix). So it
// must look before it answers: read the files, quote the lines that settle it,
// and say whether the check is right. weighDispute then tests that answer
// against what it actually read. The verdict is about the step, not the
// check: asked for CHECK RIGHT / CHECK WRONG, the model showed the step was
// done and then wrote "CHECK RIGHT", meaning the step was right.
// After a step the check couldn't judge (see checkRoom): the model proposes
// a plan change, which the user accepts or not. It's sent as a planning turn,
// so it can only read and call update_plan.
export function uncheckedPrompt(i: number, why: string): string {
  return (
    `${why}\n\nPropose a change to the plan that makes step ${i + 1} checkable, for example by splitting ` +
    "it so each step changes less, with one update_plan call. Say why in one or two lines."
  );
}

export function disputePrompt(i: number, missing: string): string {
  return (
    `The check says step ${i + 1} isn't done: ${missing}\n\n` +
    "The check can be wrong: it saw only parts of the changes. Before you change anything, read the files " +
    "it's about with read_file and quote, in a code block, the lines that show whether it's right. Then " +
    "end with one line: STEP NOT DONE if the check is right, or STEP DONE if the check is wrong. If the " +
    "step isn't done, fix it first. If it is, change nothing."
  );
}

export interface Dispute {
  // Whether the check is right: "STEP NOT DONE" agrees with it, "STEP DONE" doesn't.
  verdict: "right" | "wrong" | null;
  // It called read_file during this run of the step.
  read: boolean;
  // Lines it quoted, and those that aren't in anything it read.
  quotes: number;
  unmatched: string[];
  // It changed files or ran a command, so the check should look again.
  changed: boolean;
  // Its reply, without the verdict line.
  reason: string;
}

// Code a reply quotes: the lines of its code blocks, and inline code long
// enough to be a line rather than a name (any name matches somewhere).
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
function quotesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) out.push(...m[1].split("\n"));
  for (const m of text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  // Small models copy line numbers in ("20:  connectorId: string,"), label
  // a quote with a comment ("// Lines 114-130 show the search route"), and
  // skip parts with "...": none of those are claims about the file.
  return out
    .filter((q) => !/^\s*(\/\/|#)\s*lines?\s+\d/i.test(q) && !/^\s*(\.\.\.|…)\s*$/.test(q))
    .map((q) => norm(q.replace(/^\s*\d+\s*[:|]\s?/, "")))
    .filter((q) => q.length >= 12);
}

// Tests a retry turn's answer to disputePrompt against the tool calls: a
// claim the check is wrong counts only with quotes from files it read.
// `messages` is the retry turn; `step` is this run of the step, retry
// included, since a read in the step's first turn is as good (the model read
// the file there, then quoted it correctly in the retry).
export function weighDispute(messages: ChatMessage[], step: ChatMessage[]): Dispute {
  const results = new Map(step.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]));
  const ok = (id: string) => !(results.get(id) ?? "Error:").startsWith("Error:");
  const calls = messages.flatMap((m) => m.toolCalls ?? []);
  const readCalls = step.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === "read_file" && ok(c.id));
  const seen = norm(readCalls.map((c) => results.get(c.id)).join("\n"));
  const replyText = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "";
  const verdicts = [...replyText.matchAll(/STEP (NOT )?DONE/gi)];
  const last = verdicts[verdicts.length - 1];
  const quotes = quotesIn(replyText);
  return {
    verdict: !last ? null : last[1] ? "right" : "wrong",
    read: readCalls.length > 0,
    quotes: quotes.length,
    unmatched: quotes.filter((q) => !seen.includes(q)),
    changed: calls.some((c) => ["write_file", "edit_file", "run_command"].includes(c.name) && ok(c.id)),
    reason: norm(replyText.replace(/```[\s\S]*?```/g, " ").replace(/STEP (NOT )?DONE/gi, "")),
  };
}

// Whether a "check is wrong" answer showed it: read, quoted, and every quote
// is in what it read. Without that it's the model's word against the check's.
export const disputeHolds = (d: Dispute) => d.read && d.quotes > 0 && d.unmatched.length === 0;

// The note on a step whose check the model disputed.
export function disputeNote(missing: string, d: Dispute): string {
  const said = `The check said: ${missing}`;
  if (disputeHolds(d)) return `${said}. Llama says the check is wrong: ${clip(d.reason, 300)}`;
  const why = !d.read
    ? "without reading the files"
    : d.quotes === 0
      ? "without quoting the files"
      : `quoting lines that aren't in the files it read (${clip(d.unmatched[0], 80)})`;
  return `${said}. Llama says the check is wrong, but ${why}.`;
}

const STATUS_ICON: Record<PlanStep["status"], ReactNode> = {
  pending: <RadioButtonUncheckedIcon fontSize="small" color="disabled" />,
  running: <CircularProgress size={16} sx={{ m: "2px" }} />,
  done: <CheckCircleIcon fontSize="small" color="success" />,
  failed: <CancelIcon fontSize="small" color="error" />,
  disputed: <HelpOutlineIcon fontSize="small" color="warning" />,
};

// The plan as a checklist. Steps can be edited, removed and rerun while the
// plan isn't running, and a disputed step accepted as done. A step that has run can be opened to see its turns
// (the "Do step" message, the reply, its tool calls), which the chat itself
// doesn't show; `details` draws them, or returns null for a step with none.
export function PlanView({
  steps,
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
}: {
  steps: PlanStep[];
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
}) {
  // Once every step is done, nothing in the plan runs again: no rerun, edit
  // or cancel. Redoing work is a new plan, from a new message.
  const readOnly = !onChange || steps.every((s) => s.status === "done");
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const done = steps.filter((s) => s.status === "done").length;
  // A disputed step waits for the user, so Run would only stop on it again.
  const next = steps.find((s) => s.status !== "done");
  const unfinished = next?.status === "pending" || next?.status === "failed";
  const started = steps.some((s) => s.status !== "pending");

  // Rerunning a step leaves the ones after it done, but built on the old version.
  const rerun = (i: number) =>
    onChange?.(
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
    if (text) onChange?.(steps.map((s, j) => (j === editing.i ? { id: s.id, text, status: "pending" } : s)));
    setEditing(null);
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Plan · {done} of {steps.length} done
        </Typography>
        {since != null && counter && <Box sx={{ mr: 1 }}>{counter(since)}</Box>}
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
                          onClick={() => onChange?.(steps.map((st, j) => (j === i ? { id: st.id, text: st.text, status: "done" } : st)))}
                        >
                          <DoneIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {(s.status === "done" || s.status === "failed" || s.status === "disputed") && (
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

// A suggested plan change as a diff of step texts: removed steps struck out,
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
            {old.has(s.text) ? " " : "+"} {i + 1}. {s.text}
          </Typography>
        ))}
        {removed.map((s) => (
          <Typography key={s.id} variant="body2" color="error.main" sx={{ textDecoration: "line-through" }}>
            − {s.text}
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
