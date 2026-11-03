// Plans: the steps of a task, from the model's update_plan calls. Small models
// say they're done when they aren't, so chat runs a plan one step per turn and
// checks each step with reviewStep before ticking it off.

import { type Api, type Kind, type ChatMessage, type PlanStep, type ToolCall, streamChat } from "../api";

// With Plan on, a new message first gets a planning turn: the model can only
// read and call update_plan, so it writes the plan instead of starting on the
// work. Small models skip the plan when it's only suggested. It still gets
// every tool, and chat refuses the rest when they're called: a different tool
// list, like a different system prompt, made llama.cpp reprocess the whole
// chat. PLANNING_NOTE goes with the message, as its `note`, for the same reason.
export const PLANNING_TOOLS = new Set([
  "update_plan",
  // A todo is no change to files, and "add it to my list" is no plan.
  "add_todo",
  "list_todos",
  "complete_todo",
  "list_directory",
  "read_file",
  "find_files",
  "grep",
  "locate_path",
  // A question gets a planning turn too, and may need the web to answer.
  "web_search",
  "fetch_url",
]);
// A note: an instruction for one turn, sent after the message's text (see
// docs/guide.md, "What the model is told"). A question comes first: led by "only
// plan", the model opened its answers to questions with "This is a question,
// not a file change request", replying to a note the user never sees.
export const PLANNING_NOTE =
  "If this message is a question or otherwise doesn't change files, just answer it, and don't mention plans. " +
  "If it asks for changes to files, only plan for now: read what you need, then call update_plan with the " +
  "steps, and stop. Don't change any files yet: the user reviews the plan and runs it.";

// The plan from an update_plan call's arguments, merged with the plan so far.
// Only chat's check ticks a step off, so a step keeps its id, status and note
// only if it's the same step as before, by text, and otherwise starts pending.
// Not by position: a step that dropped the finished steps from the plan once
// gave their "done" to the steps that took their places. The step running may
// be reworded, so it keeps its id (its messages and runPlan use it) as the
// first new step with no match. See docs/guide.md, "How plans work".
export function planFromCall(args: string, old: PlanStep[], running: boolean): PlanStep[] | null {
  try {
    const steps = JSON.parse(args).steps;
    if (!Array.isArray(steps)) return null;
    const texts = steps.map((s: any) => String(typeof s === "string" ? s : s.text).trim());
    const current = running ? old.find((o) => o.status === "running") : undefined;
    let reworded = current && !texts.includes(current.text) ? current : undefined;
    return texts.map((text: string) => {
      const same = old.find((o) => o.text === text);
      if (same) return { ...same, text };
      if (reworded) {
        const step = { ...reworded, text };
        reworded = undefined;
        return step;
      }
      return { id: crypto.randomUUID(), text, status: "pending" };
    });
  } catch {
    return null;
  }
}

// The context from an update_plan call's arguments, alongside planFromCall.
export function extractContext(args: string): string | null {
  try {
    const parsed = JSON.parse(args);
    const val = parsed.context;
    if (typeof val !== "string") return null;
    const trimmed = val.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

// The message that runs step i: just that step, with the plan for context.
// Steps start with a fresh context (see runPlan), so the prompt carries what
// a step needs from before it: the context (background the model should
// remember), the request (requirements live there, not just in the step
// text), and the files earlier steps changed, to read before building on
// them (step 7 has to use the fields step 1 added).
//
// The context and request are the same for every step, so they come first:
// llama.cpp reuses a cached prompt only up to its first change. The plan's
// checkmarks, the files changed and which step to do differ, so they follow.
export function stepPrompt(
  steps: PlanStep[],
  i: number,
  request?: string,
  changed: string[] = [],
  context?: string | null,
): string {
  const list = steps.map((s, j) => `${s.status === "done" ? "[x]" : "[ ]"} ${j + 1}. ${s.text}`).join("\n");
  const parts: string[] = [];
  if (context) parts.push(`What the steps need from the conversation:\n${context}`);
  if (request) parts.push(`The task the plan is for:\n${request}`);
  parts.push(`The plan:\n${list}`);
  if (changed.length) parts.push(`Files earlier steps changed; read what this step builds on:\n${changed.join("\n")}`);
  parts.push(`Do step ${i + 1} of ${steps.length}: ${steps[i].text}`);
  return parts.join("\n\n");
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
  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId!, m]));
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
    messages.filter((m) => m.role === "tool" && !m.content.startsWith("Error:")).map((m) => m.toolCallId!),
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

// The check judges the code as it is now, not just the diffs. Diff hunks hide
// the lines around a change (a parameter looked undefined because its
// signature wasn't in the hunk), and a rerun's changes are only its fixes, so
// what an earlier attempt wrote looked missing.
// It reads with tools, like the model it checks: read_file, grep and the
// rest of the read-only disk tools. Files that fit go in its first message,
// the step's own first, then files other steps changed; the rest are listed
// for it to read. Before, files that didn't fit stopped the step: every step
// of a refactor touching Chat.tsx (~25k tokens) couldn't be checked, even
// when it only changed the imports. Nothing language-specific: the check
// decides what to read, the way a stronger model would.
// Room for files in the first message: a quarter of the model's context, at
// about 4 characters a token; the rest is for its reads and its answer.
export const checkRoom = (contextSize?: number) => Math.floor((contextSize ?? 32000) / 4) * 4;
const chars = (f: WholeFile) => ("text" in f ? f.text.length : 0);
export const CHECK_TOOLS = new Set(["read_file", "grep", "find_files", "list_directory"]);
// Reads a check makes before it must answer; it answers without tools then.
const MAX_CHECK_ROUNDS = 8;

// The files the check gets whole (own first, then others, while they fit),
// and the ones it's told to read itself.
function pack(own: WholeFile[], others: WholeFile[], room: number) {
  const shown: WholeFile[] = [];
  const left: string[] = [];
  let used = 0;
  for (const f of [...own, ...others]) {
    if ("text" in f && !f.cut && used + chars(f) <= room) {
      shown.push(f);
      used += chars(f);
    } else left.push(f.path);
  }
  return { shown, left };
}

const REVIEW_PROMPT =
  "You check whether one step of a coding task was really done. You get the step, the changes made " +
  "during it, the reply that claims it's done, and the files it changed: some as they are now, the rest " +
  "for you to read. Read what you need with the tools (read_file takes start_line and max_lines) before " +
  "you judge. Judge only this step, from the code: code that's there counts, even if an earlier attempt " +
  "wrote it, and a claim the code doesn't back up doesn't. When you're done reading, answer with exactly " +
  "one line: DONE, or MISSING: followed by what's still missing. A step that only needed reading or " +
  "checking is DONE if the reply reports what it found.";

// Asks the model whether the step's changes do what the step says, letting
// it read with the read-only disk tools. `messages` is the step's turn: from
// its "Do step" message on. `own` are the files it changed, `others` the
// files other steps changed, read now (see pack). `tools` are those tools'
// definitions; `read` runs one of their calls and returns its result.
export async function reviewStep(
  {
    connectorId,
    kind,
    api,
    model,
    think,
    room,
    tools,
    read,
  }: {
    connectorId: string;
    kind?: Kind;
    api?: Api;
    model: string;
    think: boolean;
    room: number;
    tools: unknown[];
    read: (call: ToolCall) => Promise<string>;
  },
  step: string,
  messages: ChatMessage[],
  own: WholeFile[],
  others: WholeFile[],
  signal: AbortSignal,
): Promise<{ done: boolean; missing?: string }> {
  const { shown, left } = pack(own, others, room);
  const files =
    shown.map((f) => ("text" in f ? `=== ${f.path}\n${f.text}` : "")).join("\n\n") +
    (left.length ? `\n\nAlso changed, too big to include, so read what you need: ${left.join(", ")}` : "");
  const replyText = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "";
  const history: ChatMessage[] = [
    { role: "system", content: REVIEW_PROMPT },
    {
      role: "user",
      content:
        `Step: ${step}\n\nThe files it changed, as they are now:\n${files || "(none)"}\n\n` +
        `Changes made during this step:\n${changesIn(messages) || "(no file changes)"}\n\n` +
        `The reply:\n${clip(replyText, MAX_CHANGE_CHARS) || "(empty)"}`,
    },
  ];
  let answer = "";
  for (let round = 0; ; round++) {
    answer = "";
    const last = round >= MAX_CHECK_ROUNDS;
    const { toolCalls } = await streamChat(
      // Like a reply, only the first request thinks; then it reads and decides.
      { connectorId, kind, api, model, think: think && round === 0, messages: history, tools: last ? undefined : tools },
      (d) => (answer += d.content ?? ""),
      signal,
    );
    if (last || toolCalls.length === 0) break;
    history.push({ role: "assistant", content: answer, toolCalls });
    for (const call of toolCalls) {
      const result = CHECK_TOOLS.has(call.name) ? await read(call) : `Error: ${call.name} isn't available to the check`;
      history.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }
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
// After a step whose folder's check command failed. Unlike the model check,
// the command isn't argued with: its output is the fix list.
export function commandFailedPrompt(i: number, command: string, output: string): string {
  return (
    `After step ${i + 1}, the check command \`${command}\` failed:\n\n${clip(output, 6000)}\n\n` +
    "Fix what it reports, then reply with one line saying what you changed."
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
  const results = new Map(step.filter((m) => m.role === "tool").map((m) => [m.toolCallId!, m.content]));
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
