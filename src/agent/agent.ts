// Turn-loop helpers extracted from Chat.tsx.

import { type Api, type Kind, type ChatMessage, type ToolCall, type Usage, type Todo, type ToolOutcome, type AccessRequest, type Approval, type Attachment, type AttachmentTarget, streamChat, runTool } from "../api";
import { closeOpenToolCalls } from "../closeOpenToolCalls";
import { callKey, shareTokens } from "./helpers";
import { applyTodoCall, openTodos } from "./todos";
import { PLANNING_NOTE, PLANNING_TOOLS, planFromCall, extractContext, extractPlanSummary } from "./plan";

// Maximum number of identical tool calls (same name + arguments) before the
// repeat guard fires and stops the model from looping.
export const MAX_REPEATS = 2;

// Maximum number of tool-call rounds before the loop gives up.
export const MAX_TOOL_ROUNDS = 50;

// Tool names that mutate disk; a successful run of one resets the repeat
// counter, because the same read/search may now find different content.
export const CHANGES_DISK = new Set(["write_file", "edit_file", "run_command", "create_worktree", "remove_worktree"]);

// ── repeat guard ────────────────────────────────────────────────────────────

// Tracks how many times each tool call has run in the current reply. Returns
// true when the call should be blocked (repeat guard fired).
export function shouldBlockRepeat(
  ran: Map<string, number>,
  call: ToolCall,
): { blocked: boolean; key: string; times: number } {
  const key = callKey(call);
  const times = ran.get(key) ?? 0;
  return { blocked: times >= MAX_REPEATS, key, times };
}

// Records that a tool call just ran. Call after every successful execution.
export function recordCall(ran: Map<string, number>, call: ToolCall): void {
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

// ── planning guard ──────────────────────────────────────────────────────────

// Returns true when a tool call should be blocked during a planning turn.
// Planning turns only allow read-only tools.
export function isBlockedByPlanning(call: ToolCall, planning: boolean): boolean {
  return planning && !PLANNING_TOOLS.has(call.name);
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

// Callbacks that Chat.tsx provides so runTurn can update React state and
// access external dependencies without importing React or Chat itself.
export interface RunTurnCallbacks {
  setMessages: (msgs: ChatMessage[]) => void;
  setError: (err: string | null) => void;
  setFailed: (err: string | null) => void;
  setUsage: (u: Usage | undefined) => void;
  setAbort: (c: AbortController | null) => void;
  refreshModels: (id: string) => void;
  askUser: (ask: { needsAccess: AccessRequest } | { needsApproval: Approval } | { needsLocation: { description: string; kind: AttachmentTarget["kind"] } }, signal: AbortSignal) => Promise<boolean | AttachmentTarget[]>;
  attach: (a: Attachment) => void;
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
  systemPrompt: string | null;
  toolDefinitions: any[];
  toolContextUpdate: string;
  seenUpdate: string;
  history: ChatMessage[];
  forgotten: ChatMessage[];
  attached: string[];
  chatId: string;
  controller: AbortController;
  started: number;
  text: string;
}

// The result returned by runTurn, including updated attached paths.
export interface RunTurnResult {
  ok: boolean;
  messages: ChatMessage[];
  attached: string[];
  error?: string;
}

// Runs one reply: the full turn loop (stream, tool calls, repeat/planning
// guards, plan handling) until the model stops asking for tools. Returns
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
    chatId, controller, started, text,
  } = config;
  const { setMessages, setError, setFailed, setUsage, setAbort, refreshModels, askUser, attach, setPlanProposal, setPastPlans, setPlanAnchor, setPlanContext, setPlanSummary, changePlan, todosRef, changeTodos, planRef, planRunningRef, planAnchor, planContext, planSummary } = callbacks;

  const tag = planStep ? { planStep } : {};
  let error: string | undefined;
  let ok = false;

  // attached is mutated when the user picks paths during tool execution.
  let attached = [...attachedBase];

  const update = toolsOn && toolContextUpdate !== seenUpdate ? { update: toolContextUpdate } : {};
  // A call left without a result (Stop, a reload) would break every request
  // after it, so it's closed here, and the repaired history is what's kept.
  let history: ChatMessage[] = [
    ...closeOpenToolCalls(baseHistory),
    { role: "user", content: text, ...update, ...(planning && { note: PLANNING_NOTE }), ...tag },
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
    let stopReason: string | null = null;
    let planned = false;

    for (let round = 0; ; round++) {
      const lastTurn: boolean = stopReason !== null;
      const reply: ChatMessage = { role: "assistant", content: "", reasoning: "", ...tag };
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
          messages:
            toolsOn && !lastTurn && systemPrompt
              ? [{ role: "system", content: systemPrompt }, ...history]
              : history,
          think: thinkOn && !planning && round === 0,
          tools: toolsOn && !lastTurn ? toolDefinitions : undefined,
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
        const times = ran.get(key) ?? 0;
        ran.set(key, times + 1);
        const openList = () => openTodos(todosRef.current).map(({ id, summary }) => ({ id, summary }));

        try {
          if (planning && !PLANNING_TOOLS.has(call.name)) {
            throw new Error(
              `${call.name} isn't available while planning; read what you need, then call update_plan with the steps`,
            );
          }
          if (times >= MAX_REPEATS) {
            stopReason = `Stopped: the model kept repeating ${call.name} with the same arguments.`;
            throw new Error(
              `this exact call already ran ${times} times in this reply; answer with what you have`,
            );
          }

          let outcome = await runTool(call, { chatId, attachments: attached, todos: openList() });
          while (!("result" in outcome)) {
            const answer = await askUser(outcome as any, controller.signal);
            if (controller.signal.aborted) return { ok, messages: [...forgotten, ...history], attached, error };
            toolStarted = performance.now();
            if (Array.isArray(answer)) {
              const newTargets = answer as AttachmentTarget[];
              const newPaths = newTargets.map((t) => t.path);
              attached = [...attached, ...newPaths];
              newTargets.forEach((t) => attach({ ...t, source: "request" as const }));
              const picked = newPaths.map((p: string) => `${p} (file)`).join(", ");
              outcome = {
                result:
                  "needsAccess" in outcome
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
              outcome = await runTool(call, { chatId, attachments: attached, todos: openList() });
            } else {
              const approval = (outcome as any).needsApproval;
              if (!answer) {
                outcome = {
                  result:
                    approval.type === "change"
                      ? `Error: the user didn't approve this change to ${approval.path}; nothing was written`
                      : approval.type === "worktree"
                        ? `Error: the user didn't approve removing the worktree ${approval.path}; nothing changed`
                        : "Error: the user didn't approve running this command; it didn't run",
                };
                break;
              }
              if (approval.type === "change") diff = approval.diff;
              outcome = await runTool(call, { chatId, attachments: attached, todos: openList(), approved: approval as Approval });
            }
          }
          result = outcome.result;
        } catch (e: any) {
          result = `Error: ${e.message}`;
        }

        if (CHANGES_DISK.has(call.name) && !result.startsWith("Error:")) ran.clear();

        if ((call.name === "add_todo" || call.name === "complete_todo") && !result.startsWith("Error:")) {
          changeTodos(applyTodoCall(todosRef.current, call, crypto.randomUUID().slice(0, 8), Date.now()));
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
            if (finished) setPastPlans((p: any[]) => [...p, { steps: current, anchor: planAnchor, context: planContext, summary: planSummary ?? undefined }]);
            if (!planRunningRef.current) setPlanAnchor(call.id);
            changePlan(steps);
            // A step revising the plan mid-run usually leaves context out; the
            // plan's context and summary still hold.
            if (ctx !== null || !planRunningRef.current) setPlanContext(ctx);
            if (planSum !== null || !planRunningRef.current) setPlanSummary(planSum);
          }
          if (steps && planning) planned = true;
        }

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

      if (planned) {
        ok = true;
        break;
      }
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

import { type Connector, type Model, type PlanStep, runCheckCommand } from "../api";
import { commandSummary, failureLine } from "./helpers";
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
} from "./plan";

// ── checkStep helpers ───────────────────────────────────────────────────────

// Reads the current content of files changed by a step, for its model check.
async function readWhole(
  paths: string[],
  sessionId: string,
  attachments: Attachment[],
  attachedPaths: (as: Attachment[]) => string[],
): Promise<WholeFile[]> {
  return Promise.all(
    paths.map(async (path) => {
      const call = { id: "check", name: "read_file", arguments: JSON.stringify({ path, max_lines: Number.MAX_SAFE_INTEGER }) };
      try {
        const out = await runTool(call, { chatId: `${sessionId}:check`, attachments: attachedPaths(attachments) });
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

// Runs the check command of each attached folder that has one, once the plan
// has changed files; the first that fails, or null.
async function failedCommand(
  planMessages: ChatMessage[],
  checkCommands: Record<string, string>,
  attachments: Attachment[],
  attachedPaths: (as: Attachment[]) => string[],
  setError: (err: string | null) => void,
): Promise<{ command: string; output: string; passed: boolean } | null> {
  if (filesChanged(planMessages).length === 0) return null;
  for (const folder of Object.keys(checkCommands)) {
    try {
      const r = await runCheckCommand(attachedPaths(attachments), folder);
      if (!r.passed) return r;
    } catch (e: any) {
      setError(`Couldn't run the check command for ${folder}: ${e.message}`);
    }
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
  reply: (text: string, before: ChatMessage[], opts?: { planning?: boolean; planStep?: string; from?: number }) => Promise<{ ok: boolean; messages: ChatMessage[]; error?: string }>;
  // The message that asked for the plan, sent with each step (see stepPrompt).
  request?: string;
  // The context for the plan, sent with each step (see stepPrompt).
  context?: string | null;
  // Settings → Chat, "Fresh context for each plan step"; on unless false.
  freshSteps?: boolean;
  setError: (err: string | null) => void;
  setAbort: (c: AbortController | null) => void;
  modelLoaded: () => Promise<boolean>;
  models: Model[];
  attachments: Attachment[];
  checkCommands: Record<string, string>;
  attachedPaths: (as: Attachment[]) => string[];
  sessionId: string;
  // For the check: the chat's Think setting, and every tool's definition
  // (it gets the read-only ones; see CHECK_TOOLS).
  thinkOn: boolean;
  toolDefinitions: unknown[];
  // Awaited before each step, once the previous step and its check are done.
  // It may hold (Pause); false ends the plan, leaving later steps pending.
  gate?: () => Promise<boolean>;
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
    modelLoaded, models, attachments, checkCommands, attachedPaths, sessionId, thinkOn, toolDefinitions, gate,
  } = callbacks;

  if (!connector || !model || abort || planRunningRef.current) return;
  planRunningRef.current = true;
  setPlanRunning(true);
  let msgs = messages;
  try {
    for (;;) {
      let steps = planRef.current;
      let i = steps?.findIndex((st) => st.status !== "done") ?? -1;
      if (!steps || i < 0 || steps[i].status === "disputed") break;
      // Pause holds here, after the previous step and its check. The gate
      // resolves false to end the plan (Stop). The plan may have changed while
      // it held, so the next step is read again.
      if (gate) {
        if (!(await gate())) break;
        steps = planRef.current;
        i = steps?.findIndex((st) => st.status !== "done") ?? -1;
        if (!steps || i < 0 || steps[i].status === "disputed") break;
      }
      const { id, text } = steps[i];
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
      let r = await reply(stepPrompt(steps, i, request, changed, ctx), msgs, { planStep: id, from });
      msgs = r.messages;
      let failed = r.ok ? await failedCommand(msgs.filter((m) => m.planStep), checkCommands, attachments, attachedPaths, setError) : null;
      if (failed) {
        r = await reply(commandFailedPrompt(i, failed.command, failed.output), msgs, { planStep: id, from });
        msgs = r.messages;
        failed = r.ok ? await failedCommand(msgs.filter((m) => m.planStep), checkCommands, attachments, attachedPaths, setError) : null;
        if (failed) {
          setStep(id, { status: "failed", note: `\`${failed.command}\` still fails: ${commandSummary(failed.output)}`, ms: took() });
          break;
        }
      }
      let check = r.ok ? await checkStep(text, msgs.slice(start), msgs.filter((m) => m.planStep), {
        connector, model, setAbort, setError, modelLoaded,
        models, attachments, attachedPaths, sessionId, thinkOn, toolDefinitions,
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
        failed = r.ok ? await failedCommand(msgs.filter((m) => m.planStep), checkCommands, attachments, attachedPaths, setError) : null;
        if (failed) {
          setStep(id, { status: "failed", note: `\`${failed.command}\` fails: ${commandSummary(failed.output)}`, ms: took() });
          break;
        }
        check = r.ok ? await checkStep(text, msgs.slice(start), msgs.filter((m) => m.planStep), {
          connector, model, setAbort, setError, modelLoaded,
          models, attachments, attachedPaths, sessionId, thinkOn, toolDefinitions,
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
        failed = await failedCommand(msgs.filter((m) => m.planStep), checkCommands, attachments, attachedPaths, setError);
        if (failed) {
          setStep(id, { status: "failed", note: `\`${failed.command}\` fails: ${commandSummary(failed.output)}`, ms: took() });
          asking = true;
          break;
        }
        check = await checkStep(text, msgs.slice(start), msgs.filter((m) => m.planStep), {
          connector, model, setAbort, setError, modelLoaded,
          models, attachments, attachedPaths, sessionId, thinkOn, toolDefinitions,
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
  const { connector, model, setAbort, setError, modelLoaded, models, attachments, attachedPaths, sessionId, thinkOn, toolDefinitions } =
    deps;
  if (!connector || !(await modelLoaded())) return null;
  const controller = new AbortController();
  setAbort(controller);
  try {
    const mine = filesChanged(stepMessages);
    const own = await readWhole(mine, sessionId, attachments, attachedPaths);
    const others = await readWhole(filesChanged(planMessages).filter((p) => !mine.includes(p)), sessionId, attachments, attachedPaths);
    const room = checkRoom(models.find((m) => m.id === model)?.contextSize);
    // The check's own reads, under the same chat id as readWhole's.
    const read = async (call: ToolCall) => {
      const out = await runTool(call, { chatId: `${sessionId}:check`, attachments: attachedPaths(attachments) });
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
