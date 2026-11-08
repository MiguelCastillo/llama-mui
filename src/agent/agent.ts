// Turn-loop helpers extracted from Chat.tsx.

import { type Api, type Kind, type ChatMessage, type ToolCall, type Usage, type Todo, type ToolOutcome, type AccessRequest, type Approval, type Attachment, type AttachmentTarget, type Picked, streamChat, runTool } from "../api.ts";
import { closeOpenToolCalls } from "../closeOpenToolCalls.ts";
import { callKey, shareTokens } from "./helpers.ts";
import { ProgressWatch } from "./progress.ts";
import { applyTodoCall, openTodos } from "./todos.ts";
import { addNote, isNoteTool, noteFromCall } from "./replyNotes.ts";
import { PLANNING_NOTE, planFromCall, extractContext, extractPlanSummary } from "./plan.ts";

// Maximum number of identical tool calls (same name + arguments) before the
// repeat guard fires and stops the model from looping.
export const MAX_REPEATS = 2;

// A backstop only: the real check for a reply that is stuck is ProgressWatch
// (progress.ts), which looks at what the calls did, not how many there were.
// Maximum number of tool-call rounds before the loop gives up.
export const MAX_TOOL_ROUNDS = 200;

// Tool names that mutate disk; a successful run of one resets the repeat
// counter, because the same read/search may now find different content.
export const CHANGES_DISK = new Set(["write_file", "edit_file", "run_command", "create_worktree", "remove_worktree"]);

// What the model is told when the user answers a command's or a file change's
// approval with "Make plan": nothing ran or was written, and the work goes into
// a plan instead.
export const PLAN_INSTEAD_RESULT =
  "The user doesn't want this run now; they want it as a plan. Call update_plan with the steps, this command included, then stop.";
export const PLAN_INSTEAD_CHANGE_RESULT =
  "The user doesn't want this done now; they want it as a plan. Call update_plan with the steps, this change included, then stop.";
export const PLAN_INSTEAD_WORKTREE_RESULT =
  "The user doesn't want this worktree removed now; they want it as a plan. Call update_plan with the steps, removing it included, then stop.";
export const PLAN_INSTEAD_PAGE_RESULT =
  "The user doesn't want this page opened now; they want it as a plan. Call update_plan with the steps, opening it included, then stop.";

export const PLAN_INSTEAD_ACCESS_RESULT =
  "The user doesn't want to give access to this path now; they want it as a plan. Call update_plan with the steps, using that path included, then stop.";
export const PLAN_INSTEAD_LOCATION_RESULT =
  "The user doesn't want to pick this now; they want it as a plan. Call update_plan with the steps, finding it included, then stop.";

// What the model is told when "Make plan" answers a question. Every kind can
// be turned into a plan: nothing ran, and the work goes into one. `ask` is
// what the tool asked for: an approval, a path to allow, or a thing to find.
export function planInsteadResult(ask: object): string {
  if ("needsAccess" in ask) return PLAN_INSTEAD_ACCESS_RESULT;
  if ("needsLocation" in ask) return PLAN_INSTEAD_LOCATION_RESULT;
  const approval = "needsApproval" in ask ? (ask.needsApproval as { type?: string }) : { type: undefined };
  switch (approval.type) {
    case "change":
      return PLAN_INSTEAD_CHANGE_RESULT;
    case "worktree":
      return PLAN_INSTEAD_WORKTREE_RESULT;
    case "page":
      return PLAN_INSTEAD_PAGE_RESULT;
    default:
      return PLAN_INSTEAD_RESULT;
  }
}

// ── repeat guard ────────────────────────────────────────────────────────────

// Tracks how many times each tool call has run in the current reply. Returns
// true when the call should be blocked (repeat guard fired).
export function shouldBlockRepeat(
  ran: Map<string, number>,
  call: ToolCall,
): { blocked: boolean; key: string; times: number } {
  const key = callKey(call);
  // A note is never a repeat: two of them are two notes.
  const times = isNoteTool(call.name) ? 0 : ran.get(key) ?? 0;
  return { blocked: times >= MAX_REPEATS, key, times };
}

// Records that a tool call just ran. Call after every successful execution.
export function recordCall(ran: Map<string, number>, call: ToolCall): void {
  if (isNoteTool(call.name)) return;
  const key = callKey(call);
  const times = ran.get(key) ?? 0;
  ran.set(key, times + 1);
}

// Resets the repeat counter when a disk-changing tool succeeds.
export function resetOnDiskChange(ran: Map<string, number>, call: ToolCall, result: string): void {
  if (CHANGES_DISK.has(call.name) && !result.startsWith("Error:")) {
    ran.clear();
  }
}

// ── turn result ─────────────────────────────────────────────────────────────

// What a single round of the turn loop produces: the assistant's reply,
// any tool calls it made (empty on the last turn), and whether the loop
// should stop after this round.
export interface RoundResult {
  reply: ChatMessage;
  toolCalls: ToolCall[];
  stopReason: string | null;
  // True when the model produced a plan and the loop should end.
  planned: boolean;
  // Updated history including the reply and all tool results.
  history: ChatMessage[];
  // Updated repeat tracker.
  ran: Map<string, number>;
}

// ── runTurn ─────────────────────────────────────────────────────────────────

// Callbacks that the runner provides (src/runnerReply.ts, on the server) so
// runTurn can update the session and reach external dependencies without
// importing React or Chat.
export interface RunTurnCallbacks {
  setMessages: (msgs: ChatMessage[]) => void;
  setError: (err: string | null) => void;
  setFailed: (err: string | null) => void;
  setUsage: (u: Usage | undefined) => void;
  setAbort: (c: AbortController | null) => void;
  refreshModels: (id: string) => void;
  askUser: (ask: { needsAccess: AccessRequest } | { needsApproval: Approval } | { needsLocation: { description: string; kind: AttachmentTarget["kind"]; canSetWorkingDir?: boolean } }, signal: AbortSignal) => Promise<boolean | "plan" | Picked[]>;
  attach: (a: Attachment) => void;
  // The user chose this folder as the chat's working directory (see Picked).
  setWorkingDir: (path: string) => void;
  setPlanProposal: (p: any[]) => void;
  setPastPlans: (fn: (p: any[]) => any[]) => void;
  setPlanAnchor: (a: string | null) => void;
  setPlanContext: (c: string | null) => void;
  setPlanSummary: (s: string | null) => void;
  changePlan: (s: any[]) => void;
  // The session's todos; the ref is the latest, for calls within one reply.
  todosRef: { current: Todo[] };
  changeTodos: (t: Todo[]) => void;
  planRef: { current: any[] | null };
  planRunningRef: { current: boolean };
  planAnchor: string | null;
  planContext: string | null;
  planSummary: string | null;
  // The plan's id, if it has one (it moved into a thread; see Session.planId).
  // A finished plan that a new one replaces is archived with it, and the new
  // plan starts without one.
  planId?: string | null;
  setPlanId?: (id: string | null) => void;
}

// Configuration needed for a single reply turn.
export interface RunTurnConfig {
  connectorId: string;
  kind?: Kind;
  api?: Api;
  model: string;
  toolsOn: boolean;
  thinkOn: boolean;
  planning: boolean;
  planStep?: string;
  // A side question asked while a plan runs (server/aside.ts): every message
  // the reply makes carries `aside`, so the plan's steps never see it.
  aside?: boolean;
  // Instructions for this message, sent after its text, in place of the
  // planning note.
  note?: string;
  // When set, only these tools may run; a call to another gets an error
  // result (a side question uses ASIDE_TOOLS, see plan.ts).
  allowedTools?: ReadonlySet<string>;
  systemPrompt: string | null;
  toolDefinitions: any[];
  toolContextUpdate: string;
  seenUpdate: string;
  history: ChatMessage[];
  forgotten: ChatMessage[];
  // The folder relative paths and commands start in; null is none.
  workingDir: string | null;
  // The extra files and folders; the working directory is not one of them.
  attached: string[];
  chatId: string;
  controller: AbortController;
  started: number;
  text: string;
  // Image refs on the user message (only meaningful on a chat turn, not a plan step).
  images?: { id: string; mediaType: string }[];
  // Image id → base64 data. Set by the server (makeReply) so every streamChat
  // call in the loop gets the images; left out on the browser.
  imagesBase64?: Record<string, string>;
}

// The result returned by runTurn, including updated attached paths.
export interface RunTurnResult {
  ok: boolean;
  messages: ChatMessage[];
  attached: string[];
  error?: string;
}

// Runs one reply: the full turn loop (stream, tool calls, the repeat guard,
// plan handling) until the model stops asking for tools. A main-chat reply
// (`planning` on) may call any tool: the model decides by size (see
// workPolicy.ts), and writes and commands reach the normal approval prompt.
// Only `allowedTools` (a side question) restricts the tools. Returns
// whether the reply succeeded, the final history, any error, and the
// updated attached paths.
export async function runTurn(
  config: RunTurnConfig,
  callbacks: RunTurnCallbacks,
): Promise<RunTurnResult> {
  const {
    connectorId, kind, api, model, toolsOn, thinkOn, planning, planStep,
    systemPrompt, toolDefinitions, toolContextUpdate, seenUpdate,
    history: baseHistory, forgotten, attached: attachedBase,
    chatId, controller, started, text, images, imagesBase64,
  } = config;
  const { setMessages, setError, setFailed, setUsage, setAbort, refreshModels, askUser, attach, setWorkingDir, setPlanProposal, setPastPlans, setPlanAnchor, setPlanContext, setPlanSummary, changePlan, todosRef, changeTodos, planRef, planRunningRef, planAnchor, planContext, planSummary } = callbacks;

  const tag = { ...(planStep ? { planStep } : {}), ...(config.aside ? { aside: true } : {}) };
  const noteText = config.note ?? (planning ? PLANNING_NOTE : undefined);
  const { allowedTools } = config;
  let error: string | undefined;
  let ok = false;

  // Both change when the user picks paths during tool execution: a folder
  // chosen as the working directory is where the rest of this reply's calls
  // start, and the session gets it through setWorkingDir.
  let workingDir = config.workingDir;
  let attached = [...attachedBase];

  const update = toolsOn && toolContextUpdate !== seenUpdate ? { update: toolContextUpdate } : {};
  // A call left without a result (Stop, a reload) would break every request
  // after it, so it's closed here, and the repaired history is what's kept.
  let history: ChatMessage[] = [
    ...closeOpenToolCalls(baseHistory),
    { role: "user", content: text, ...update, ...(noteText && { note: noteText }), ...(images ? { images } : {}), ...tag },
  ];
  setError(null);
  setFailed(null);

  setAbort(controller);
  const startedTime = performance.now();
  let pieces = 0;
  let streamedMs = 0;
  let serverTps: number | undefined;

  try {
    let lastToolResults: number[] = [];
    const ran = new Map<string, number>();
    const watch = new ProgressWatch();
    let stopReason: string | null = null;
    let planned = false;
    // True when a call put a note on the reply this round.
    let noted = false;

    for (let round = 0; ; round++) {
      const lastTurn: boolean = stopReason !== null;
      const reply: ChatMessage = { role: "assistant", content: "", reasoning: "", model, ...tag };
      let thinkStart = 0;
      let thinkEnd = 0;
      let thinkPieces = 0;
      const show = () => setMessages([...forgotten, ...history, { ...reply }]);
      const streamRate = { pieces: 0, first: 0 };

      show();
      const { toolCalls: asked, usage: replyUsage, blocks } = await streamChat(
        {
          connectorId,
          kind,
          api,
          model,
          // The system prompt goes with every request, the last one included:
          // the working directory and the way to answer are in it. Only the
          // tools are left off, so the model says what it has instead of
          // calling another.
          messages:
            systemPrompt
              ? [{ role: "system", content: systemPrompt }, ...history]
              : history,
          think: thinkOn && !planning && round === 0,
          tools: toolsOn && !lastTurn ? toolDefinitions : undefined,
          images: imagesBase64,
        },
        (d) => {
          streamRate.first ||= performance.now();
          streamRate.pieces++;
          if (d.reasoning) {
            thinkStart ||= performance.now();
            thinkPieces++;
          }
          if (d.content && thinkStart) thinkEnd ||= performance.now();
          reply.content += d.content ?? "";
          reply.reasoning += d.reasoning ?? "";
          show();
        },
        controller.signal,
      );

      const toolCalls: ToolCall[] = lastTurn ? [] : asked;
      if (replyUsage) setUsage(replyUsage);
      if (streamRate.first) {
        pieces += streamRate.pieces;
        streamedMs += performance.now() - streamRate.first;
      }
      serverTps = replyUsage?.tokensPerSecond ?? serverTps;
      if (thinkStart) reply.stats = { ms: (thinkEnd || performance.now()) - thinkStart, tokens: thinkPieces };
      if (replyUsage?.promptTokens && lastToolResults.length) {
        history = shareTokens(history, lastToolResults, replyUsage.promptTokens);
      }
      lastToolResults = [];

      if (!toolCalls.length && !reply.content.trim() && reply.reasoning?.trim()) {
        reply.content = reply.reasoning.trim();
        reply.reasoning = "";
      } else if (blocks) {
        reply.blocks = blocks;
      }
      if (toolCalls.length) reply.toolCalls = toolCalls;
      history = [...history, reply];
      const replyAt = history.length - 1;
      setMessages([...forgotten, ...history]);

      if (!toolCalls.length) {
        if (stopReason) setError(stopReason);
        ok = !stopReason;
        break;
      }

      for (const call of toolCalls) {
        if (controller.signal.aborted) return { ok, messages: [...forgotten, ...history], attached, error };
        let toolStarted = performance.now();
        let result: string;
        let diff: string | undefined;

        const key = callKey(call);
        // Notes are not counted: each one is a new note.
        const times = isNoteTool(call.name) ? 0 : ran.get(key) ?? 0;
        if (!isNoteTool(call.name)) ran.set(key, times + 1);
        const openList = () => openTodos(todosRef.current).map(({ id, summary }) => ({ id, summary }));

        try {
          // Only a side question has an allow-list; a main-chat reply has none.
          if (allowedTools && !allowedTools.has(call.name)) {
            throw new Error(
              `${call.name} isn't available here: this reply can only read, and can't change files or the plan. Say what you found, and what the user could tell the plan to do.`,
            );
          }
          if (times >= MAX_REPEATS) {
            stopReason = `Stopped: the model kept repeating ${call.name} with the same arguments.`;
            throw new Error(
              `this exact call already ran ${times} times in this reply; answer with what you have`,
            );
          }

          let outcome = await runTool(call, { chatId, workingDir, attachments: attached, todos: openList(), connectorId, model });
          while (!("result" in outcome)) {
            // Only a chat with no working directory offers to make the folder one.
            if ("needsLocation" in outcome && workingDir === null && outcome.needsLocation.kind === "folder") {
              outcome = { needsLocation: { ...outcome.needsLocation, canSetWorkingDir: true } };
            }
            const answer = await askUser(outcome as any, controller.signal);
            if (controller.signal.aborted) return { ok, messages: [...forgotten, ...history], attached, error };
            toolStarted = performance.now();
            // Make plan answers any question the same way: nothing was done, and
            // the work goes into a plan.
            if (answer === "plan") {
              outcome = { result: planInsteadResult(outcome) };
              break;
            }
            if (Array.isArray(answer)) {
              // The working directory is not also an attachment. Only for a folder,
              // and only when the chat has none (the prompt offers it only then).
              const home = "needsLocation" in outcome && workingDir === null
                ? answer.find((t) => t.asWorkingDir && t.kind === "folder")
                : undefined;
              if (home) {
                workingDir = home.path;
                setWorkingDir(home.path);
              }
              const newTargets = answer.filter((t) => t !== home);
              const newPaths = newTargets.map((t) => t.path);
              attached = [...attached, ...newPaths];
              newTargets.forEach((t) => attach({ path: t.path, kind: t.kind, source: "request" as const }));
              const picked = newTargets.map((t) => `${t.path} (${t.kind})`).join(", ");
              outcome = {
                result: home
                  ? `The user picked ${home.path} and made it the working directory: relative paths and run_command start there from now on. Use that path.${picked ? ` Also attached: ${picked}.` : ""}`
                  : "needsAccess" in outcome
                    ? `Instead of ${(outcome as any).needsAccess.path}, the user attached ${picked}. Use that path; call the tool again with it.`
                    : `The user picked ${picked}; it's attached to this chat. Use that path.`,
              };
              break;
            }
            if ("needsLocation" in outcome) {
              outcome = { result: `Error: the user didn't pick ${(outcome as any).needsLocation.description}` };
              break;
            }
            if ("needsAccess" in outcome) {
              const target = (outcome as any).needsAccess;
              if (!target.kind) {
                outcome = { result: `Error: nothing exists at ${target.path}, and the user didn't point to where it is` };
                break;
              }
              if (!answer) {
                outcome = { result: `Error: the user didn't allow access to ${target.path}` };
                break;
              }
              attached = [...attached, target.path];
              attach({ path: target.path, kind: target.kind, source: "request" });
              outcome = await runTool(call, { chatId, workingDir, attachments: attached, todos: openList(), connectorId, model });
            } else {
              const approval = (outcome as any).needsApproval;
              if (!answer) {
                outcome = {
                  result:
                    approval.type === "change"
                      ? `Error: the user didn't approve this change to ${approval.path}; nothing was written`
                      : approval.type === "worktree"
                        ? `Error: the user didn't approve removing the worktree ${approval.path}; nothing changed`
                        : approval.type === "page"
                          ? `Error: the user didn't allow opening ${approval.url}; it wasn't opened. Use a localhost page or ask them.`
                          : "Error: the user didn't approve running this command; it didn't run",
                };
                break;
              }
              if (approval.type === "change") diff = approval.diff;
              outcome = await runTool(call, { chatId, workingDir, attachments: attached, todos: openList(), connectorId, model, approved: approval as Approval });
            }
          }
          result = outcome.result;
        } catch (e: any) {
          result = `Error: ${e.message}`;
        }

        if (CHANGES_DISK.has(call.name) && !result.startsWith("Error:")) ran.clear();

        if ((call.name === "add_todo" || call.name === "complete_todo") && !result.startsWith("Error:")) {
          changeTodos(applyTodoCall(todosRef.current, call, newId().slice(0, 8), Date.now()));
        }

        // A note (one of the kinds in replyNoteKinds.ts) goes on the reply that
        // called it, up to its kind's per-reply cap. It ends the turn, as a
        // saved plan does: the note is shown in its own box, and a reply that
        // went on would repeat it. The one exception is a plan step, which must
        // run on to its own end whatever the model notes along the way.
        if (isNoteTool(call.name) && !result.startsWith("Error:") && noteFromCall(call)) {
          history = history.map((m, i) => (i === replyAt ? addNote(m, call) : m));
          if (!planStep) noted = true;
        }

        if (call.name === "update_plan" && !result.startsWith("Error:")) {
          const current = planRef.current ?? [];
          const finished = current.length > 0 && current.every((st: any) => st.status === "done");
          const old = finished ? [] : current;
          const steps = planFromCall(call.arguments, old, planRunningRef.current);
          const ctx = extractContext(call.arguments);
          const planSum = extractPlanSummary(call.arguments);
          const underway = old.some((st: any) => st.status !== "pending") && old.some((st: any) => st.status !== "done");
          if (steps && underway && !planRunningRef.current) {
            setPlanProposal(steps);
            result = "Proposed, not made: the user sees your change next to the plan and decides. Tell them what you changed and why.";
          } else if (steps) {
            if (finished) {
              setPastPlans((p: any[]) => [
                ...p,
                { steps: current, anchor: planAnchor, context: planContext, summary: planSummary ?? undefined, ...(callbacks.planId ? { planId: callbacks.planId } : {}) },
              ]);
              callbacks.setPlanId?.(null);
            }
            if (!planRunningRef.current) setPlanAnchor(call.id);
            changePlan(steps);
            // A step revising the plan mid-run usually leaves context out; the
            // plan's context and summary still hold.
            if (ctx !== null || !planRunningRef.current) setPlanContext(ctx);
            if (planSum !== null || !planRunningRef.current) setPlanSummary(planSum);
          }
          // In a main-chat reply a saved plan ends the turn: told to go on,
          // a small model kept rewording the plan instead of stopping.
          if (steps && planning) planned = true;
        }

        watch.record(call, result);
        lastToolResults.push(history.length);
        history = [
          ...history,
          {
            role: "tool",
            content: result,
            toolCallId: call.id,
            stats: { ms: performance.now() - toolStarted },
            ...(diff && !result.startsWith("Error:") && { diff }),
            ...tag,
          },
        ];
        setMessages([...forgotten, ...history]);
      }

      if (planned || noted) {
        ok = true;
        break;
      }
      // Stuck is what the calls did (the same failure again, nothing new), not how many there were.
      const stuck = watch.endRound();
      if (stuck) stopReason ??= `Stopped: ${stuck}`;
      if (round === MAX_TOOL_ROUNDS - 1) stopReason ??= `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls.`;
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      error = String(e);
      if (!planStep) setFailed(error);
    }
  } finally {
    setAbort(null);
    refreshModels(connectorId);
  }

  const lastReply = history.map((m) => m.role).lastIndexOf("assistant");
  if (lastReply >= 0) {
    history = history.map((m, i) =>
      i === lastReply
        ? {
            ...m,
            took: {
              ms: performance.now() - started,
              clientTps: streamedMs >= 500 ? pieces / (streamedMs / 1000) : undefined,
              serverTps,
            },
          }
        : m,
    );
    setMessages([...forgotten, ...history]);
  }
  return { ok, messages: [...forgotten, ...history], attached, error };
}

// ── plan runner ──────────────────────────────────────────────────────────────

import { type Connector, type Model, type PlanStep, runCheckCommand } from "../api.ts";
import { commandSummary, failureLine } from "./helpers.ts";
import {
  stepPrompt,
  filesChanged,
  CHECK_TOOLS,
  checkRoom,
  reviewStep,
  commandFailedPrompt,
  disputePrompt,
  weighDispute,
  disputeHolds,
  disputeNote,
  recoveryPrompt,
  parseQuestion,
  stepOutput,
  type WholeFile,
  type Dispute,
} from "./plan.ts";
import { newId } from "../uuid.ts";
import { withoutAsides } from "../asides.ts";

// ── checkStep helpers ───────────────────────────────────────────────────────

// Reads the current content of files changed by a step, for its model check.
async function readWhole(
  paths: string[],
  sessionId: string,
  workingDir: string | null,
  attachments: Attachment[],
  attachedPaths: (as: Attachment[]) => string[],
): Promise<WholeFile[]> {
  return Promise.all(
    paths.map(async (path) => {
      const call = { id: "check", name: "read_file", arguments: JSON.stringify({ path, max_lines: Number.MAX_SAFE_INTEGER }) };
      try {
        const out = await runTool(call, { chatId: `${sessionId}:check`, workingDir, attachments: attachedPaths(attachments) });
        if (!("result" in out)) return { path, error: "it isn't attached to this session" };
        if (out.result.startsWith("Error:")) return { path, error: out.result.slice(7).trim() };
        const text = out.result.slice(out.result.indexOf("\n") + 1);
        return { path, text, cut: /… \(output cut at \d+ characters\)$/.test(text) };
      } catch (e: any) {
        return { path, error: e.message };
      }
    }),
  );
}

// Runs the working directory's check command, if it has one, once the plan has
// changed files; the result if it fails, or null. Only the working directory
// has a check command (see Session settings).
async function failedCommand(
  planMessages: ChatMessage[],
  checkCommands: Record<string, string>,
  workingDir: string | null,
  attachments: Attachment[],
  attachedPaths: (as: Attachment[]) => string[],
  setError: (err: string | null) => void,
): Promise<{ command: string; output: string; passed: boolean } | null> {
  if (!workingDir || !checkCommands[workingDir]) return null;
  if (filesChanged(planMessages).length === 0) return null;
  try {
    const r = await runCheckCommand(workingDir, attachedPaths(attachments), workingDir);
    if (!r.passed) return r;
  } catch (e: any) {
    setError(`Couldn't run the check command for ${workingDir}: ${e.message}`);
  }
  return null;
}

// ── runPlan ──────────────────────────────────────────────────────────────────

// Callbacks that Chat.tsx provides so runPlan can update React state.
export interface RunPlanCallbacks {
  connector: Connector | null;
  model: string;
  abort: AbortController | null;
  planRunningRef: { current: boolean };
  setPlanRunning: (v: boolean) => void;
  messages: ChatMessage[];
  planRef: { current: PlanStep[] | null };
  setStep: (id: string, patch: Omit<PlanStep, "id" | "text">) => void;
  reply: (text: string, before: ChatMessage[], opts?: { planning?: boolean; planStep?: string; from?: number; images?: { id: string; mediaType: string }[] }) => Promise<{ ok: boolean; messages: ChatMessage[]; error?: string }>;
  // The message that asked for the plan, sent with each step (see stepPrompt).
  request?: string;
  // The context for the plan, sent with each step (see stepPrompt).
  context?: string | null;
  // Settings → Tools, "Fresh context for each plan step"; on unless false.
  freshSteps?: boolean;
  setError: (err: string | null) => void;
  setAbort: (c: AbortController | null) => void;
  modelLoaded: () => Promise<boolean>;
  models: Model[];
  // The folder relative paths and commands start in; null is none. Its check
  // command, if it has one, runs after the plan has changed files.
  workingDir: string | null;
  // The extra files and folders; the working directory is not one of them.
  attachments: Attachment[];
  checkCommands: Record<string, string>;
  attachedPaths: (as: Attachment[]) => string[];
  sessionId: string;
  // For the check: the chat's Think setting, and every tool's definition
  // (it gets the read-only ones; see CHECK_TOOLS).
  thinkOn: boolean;
  toolDefinitions: unknown[];
  // Awaited before each step, once the previous step and its check are done.
  // It may wait; false ends the plan, leaving later steps pending.
  gate?: () => Promise<boolean>;
  // Called before each step, right after the gate. Returns the messages the
  // user sent while the plan ran and no step has seen yet (user messages, in
  // order). They join the chat before the step, and because a step starts with
  // a fresh context they also go in its prompt, and in every later step's (see
  // stepPrompt). `number` is the step's place in the plan, counting from 1.
  userNotes?: (step: { id: string; number: number }) => ChatMessage[];
}

// Rounds a blocked step gets to fix itself after the dispute retry, before it
// fails. A round may end in a question for the user instead (status waiting).
export const MAX_RECOVERY_ROUNDS = 2;

// Runs the plan's open steps in order, one turn each, and checks every step
// before ticking it off. A step the check still calls unfinished after the
// dispute retry gets recovery rounds (see recoveryPrompt) rather than ending
// the plan: it either gets fixed, asks the user a question and waits, or fails.
export async function runPlan(callbacks: RunPlanCallbacks): Promise<void> {
  const {
    connector, model, abort, planRunningRef, setPlanRunning,
    messages, planRef, setStep, reply, setError, setAbort,
    modelLoaded, models, workingDir, attachments, checkCommands, attachedPaths, sessionId, thinkOn, toolDefinitions, gate,
  } = callbacks;

  if (!connector || !model || abort || planRunningRef.current) return;
  planRunningRef.current = true;
  setPlanRunning(true);
  // The plan works with its own messages only: a side question (see
  // src/asides.ts) is never in a step's history, prompt, files-changed list or
  // check. The runner that owns the session keeps them and puts them back.
  let msgs = withoutAsides(messages);
  // What the user said to the run so far, for the prompts of the steps after.
  const noted: string[] = [];
  try {
    for (;;) {
      let steps = planRef.current;
      let i = steps?.findIndex((st) => st.status !== "done") ?? -1;
      if (!steps || i < 0 || steps[i].status === "disputed") break;
      // The gate is asked after the previous step and its check. It resolves
      // false to end the plan (it was stopped). The plan may have changed
      // meanwhile, so the next step is read again.
      if (gate) {
        if (!(await gate())) break;
        steps = planRef.current;
        i = steps?.findIndex((st) => st.status !== "done") ?? -1;
        if (!steps || i < 0 || steps[i].status === "disputed") break;
      }
      const { id, text } = steps[i];
      // Messages the user sent during the previous step (or while Pause held)
      // come in here, before this step's own messages begin.
      const added = callbacks.userNotes?.({ id, number: i + 1 }) ?? [];
      if (added.length) {
        msgs = [...msgs, ...added];
        noted.push(...added.map((m) => m.content));
      }
      // The user's answer to this step's question (see stepPrompt). setStep
      // patches replace the rest, so a patch that leaves the step to run again
      // carries them, or a rerun would lose the answer.
      const keep = steps[i].answer ? { answer: steps[i].answer, asked: steps[i].asked } : {};
      setStep(id, { status: "running", ...keep });
      const start = msgs.length;
      const startedAt = performance.now();
      const took = () => performance.now() - startedAt;
      // With freshSteps (the default), each step starts fresh: the model gets
      // the request, the plan, the files earlier steps changed and this step's
      // own turns, not earlier steps or the planning discussion. With all of
      // it, long plans filled the 64k context every step or two. The session
      // keeps everything, for chatting after the plan.
      const fresh = callbacks.freshSteps !== false;
      const from = fresh ? start : undefined;
      const changed = fresh ? filesChanged(msgs.filter((m) => m.planStep)) : [];
      const request = fresh ? callbacks.request : undefined;
      const ctx = fresh ? callbacks.context : undefined;
      // Without fresh steps the model has the messages in its history already.
      let r = await reply(stepPrompt(steps, i, request, changed, ctx, fresh ? noted : []), msgs, { planStep: id, from });
      msgs = r.messages;
      let failed = r.ok ? await failedCommand(msgs.filter((m) => m.planStep), checkCommands, workingDir, attachments, attachedPaths, setError) : null;
      if (failed) {
        r = await reply(commandFailedPrompt(i, failed.command, failed.output), msgs, { planStep: id, from });
        msgs = r.messages;
        failed = r.ok ? await failedCommand(msgs.filter((m) => m.planStep), checkCommands, workingDir, attachments, attachedPaths, setError) : null;
        if (failed) {
          setStep(id, { status: "failed", note: `\`${failed.command}\` still fails: ${commandSummary(failed.output)}`, ms: took() });
          break;
        }
      }
      let check = r.ok ? await checkStep(text, msgs.slice(start), msgs.filter((m) => m.planStep), {
        connector, model, setAbort, setError, modelLoaded,
        models, workingDir, attachments, attachedPaths, sessionId, thinkOn, toolDefinitions,
      }) : null;
      if (check && !check.done) {
        const missing = check.missing ?? "";
        const retryStart = msgs.length;
        r = await reply(disputePrompt(i, missing), msgs, { planStep: id, from });
        msgs = r.messages;
        const d = r.ok ? weighDispute(msgs.slice(retryStart), msgs.slice(start)) : null;
        if (d?.verdict === "wrong" && !d.changed) {
          setStep(id, { status: disputeHolds(d) ? "disputed" : "failed", note: disputeNote(missing, d), ms: took() });
          break;
        }
        failed = r.ok ? await failedCommand(msgs.filter((m) => m.planStep), checkCommands, workingDir, attachments, attachedPaths, setError) : null;
        if (failed) {
          setStep(id, { status: "failed", note: `\`${failed.command}\` fails: ${commandSummary(failed.output)}`, ms: took() });
          break;
        }
        check = r.ok ? await checkStep(text, msgs.slice(start), msgs.filter((m) => m.planStep), {
          connector, model, setAbort, setError, modelLoaded,
          models, workingDir, attachments, attachedPaths, sessionId, thinkOn, toolDefinitions,
        }) : null;
      }
      // Still not done after the dispute retry: the step is blocked. Recovery
      // rounds, never after a failed reply or an aborted run (check null).
      let asking = false;
      for (let round = 0; check && !check.done && round < MAX_RECOVERY_ROUNDS; round++) {
        const roundStart = msgs.length;
        r = await reply(recoveryPrompt(i, check.missing ?? "", stepOutput(msgs.slice(start))), msgs, { planStep: id, from });
        msgs = r.messages;
        if (!r.ok) {
          check = null;
          break;
        }
        const said = [...msgs.slice(roundStart)].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "";
        const question = parseQuestion(said);
        if (question) {
          setStep(id, { status: "waiting", note: question, ms: took() });
          asking = true;
          break;
        }
        failed = await failedCommand(msgs.filter((m) => m.planStep), checkCommands, workingDir, attachments, attachedPaths, setError);
        if (failed) {
          setStep(id, { status: "failed", note: `\`${failed.command}\` fails: ${commandSummary(failed.output)}`, ms: took() });
          asking = true;
          break;
        }
        check = await checkStep(text, msgs.slice(start), msgs.filter((m) => m.planStep), {
          connector, model, setAbort, setError, modelLoaded,
          models, workingDir, attachments, attachedPaths, sessionId, thinkOn, toolDefinitions,
        });
      }
      // The step waits for an answer, or failed on a command: the plan stops.
      if (asking) break;
      if (!check) {
        setStep(id, r.error
          ? { status: "pending", note: `The reply failed: ${failureLine(r.error, connector.name || connector.kind)}`, ...keep }
          : { status: "pending", ...keep });
        break;
      }
      setStep(id, check.done
        ? { status: "done", ms: took() }
        : { status: "failed", note: check.missing ?? "", ms: took() });
      if (!check.done) break;
    }
  } finally {
    planRunningRef.current = false;
    setPlanRunning(false);
  }
}

// ── checkStep ────────────────────────────────────────────────────────────────

export interface CheckStepDeps {
  connector: Connector | null;
  model: string;
  setAbort: (c: AbortController | null) => void;
  setError: (err: string | null) => void;
  modelLoaded: () => Promise<boolean>;
  models: Model[];
  workingDir: string | null;
  attachments: Attachment[];
  attachedPaths: (as: Attachment[]) => string[];
  sessionId: string;
  thinkOn: boolean;
  toolDefinitions: unknown[];
}

export async function checkStep(
  step: string,
  stepMessages: ChatMessage[],
  planMessages: ChatMessage[],
  deps: CheckStepDeps,
): Promise<Awaited<ReturnType<typeof reviewStep>> | null> {
  const { connector, model, setAbort, setError, modelLoaded, models, workingDir, attachments, attachedPaths, sessionId, thinkOn, toolDefinitions } =
    deps;
  if (!connector || !(await modelLoaded())) return null;
  const controller = new AbortController();
  setAbort(controller);
  try {
    const mine = filesChanged(stepMessages);
    const own = await readWhole(mine, sessionId, workingDir, attachments, attachedPaths);
    const others = await readWhole(filesChanged(planMessages).filter((p) => !mine.includes(p)), sessionId, workingDir, attachments, attachedPaths);
    const room = checkRoom(models.find((m) => m.id === model)?.contextSize);
    // The check's own reads, under the same chat id as readWhole's.
    const read = async (call: ToolCall) => {
      const out = await runTool(call, { chatId: `${sessionId}:check`, workingDir, attachments: attachedPaths(attachments) });
      return "result" in out ? out.result : "Error: that isn't attached to this session";
    };
    const tools = toolDefinitions.filter((d) => CHECK_TOOLS.has((d as { function: { name: string } }).function.name));
    return await reviewStep(
      { connectorId: connector.id, kind: connector.kind, api: connector.api, model, think: thinkOn, room, tools, read },
      step,
      stepMessages,
      own,
      others,
      controller.signal,
    );
  } catch (e: any) {
    if (!controller.signal.aborted) setError(`Couldn't check the step: ${e.message}`);
    return null;
  } finally {
    setAbort(null);
  }
}
