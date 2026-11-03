// The reply a runner sends for each plan step: Chat's reply() without React.
// Everything runTurn reports is written into the runner's session, so the
// session is the same whether or not Chat is showing it. No React in this file.

import { type Attachment, type Session, listModels, renameSession } from "./api.ts";
import { type RunPlanCallbacks, type RunTurnCallbacks, runTurn } from "./agent/agent.ts";
import { INTERRUPTED } from "./agent/helpers.ts";
import { askForSessionName } from "./agent/sessionNaming.ts";
import type { RunnerHandle } from "./runnerTypes.ts";

// The working directory: the first attached folder (Chat settings moves
// another one first).
export const workingDirOf = (as: Attachment[]): string | null => as.find((a) => a.kind === "folder")?.path ?? null;

// The paths the disk tools may use: the working folder first.
export function attachedPaths(as: Attachment[]): string[] {
  const dir = as.find((a) => a.kind === "folder")?.path;
  return [...(dir ? [dir] : []), ...as.map((a) => a.path).filter((p) => p !== dir)];
}

// Asks the server, fresh, whether the model is loaded, as Chat does before it
// sends anything. A server that doesn't report status has nothing to load, and
// one that can't be asked is left to fail the request with its own error.
// Not loaded: the runner's error says so.
export async function modelLoaded(h: RunnerHandle): Promise<boolean> {
  const { connector, model } = h.env;
  if (!connector || !model) return false;
  let status: string | undefined;
  try {
    status = (await listModels(connector.id)).find((m) => m.id === model)?.status;
  } catch {
    return true;
  }
  if (!status || status === "unknown" || status === "loaded") return true;
  h.setError(`${model} isn't loaded, so nothing was sent. Load it with ▶ in the model menu, then continue.`);
  return false;
}

// Builds the function that streams one reply for the runner: history from
// `before` (not the session's messages), the model's tool calls, a name for
// the session after its first good reply. Returns the messages it ended with
// and whether the model finished (not stopped, failed or cut off by a limit).
// `planStep`: the turn runs that plan step; its messages carry the step's id.
export function makeReply(h: RunnerHandle): RunPlanCallbacks["reply"] {
  return async (text, before, { planning = false, planStep, from } = {}) => {
    const { connector, model, toolsOn, thinkOn, toolContext } = h.env;
    const first = h.getSession();
    // Where the model's history starts: the session's (after a clear), or for
    // a plan step, the step's own first message (see runPlan).
    const start = Math.max(from ?? first.contextStart, first.contextStart);
    if (!connector) return { ok: false, messages: before };
    // Every request checks: the model may have been unloaded since the last.
    if (!(await modelLoaded(h))) return { ok: false, messages: before };
    // Fixed for the session's first reply, so its system prompt never changes.
    h.edit((s) => (s.promptDir === undefined ? { ...s, promptDir: workingDirOf(s.attachments) } : s));
    const forgotten = before.slice(0, start);
    // Attachments and tools that are off go the same way, as `update`, and
    // only when they changed since the last one the model saw.
    const seen = [...before.slice(start)].reverse().find((m) => m.update)?.update;
    const controller = new AbortController();
    const started = performance.now();
    const now = h.getSession();

    // The saved copy says "interrupted" while a request is in flight, as Chat's
    // does, so a reload during a reply doesn't look like a finished one.
    let failed: string | null = null;
    let streaming = false;
    const syncFailed = () =>
      h.edit((s) => {
        const f = streaming ? INTERRUPTED : failed;
        return s.failed === f ? s : { ...s, failed: f };
      });

    const callbacks: RunTurnCallbacks = {
      setMessages: (messages) => h.edit((s) => ({ ...s, messages })),
      setError: h.setError,
      setFailed: (f) => {
        failed = f;
        syncFailed();
      },
      setUsage: (u) => {
        if (u) h.edit((s) => ({ ...s, usage: u }));
      },
      setAbort: (c) => {
        streaming = c !== null;
        syncFailed();
        h.setAbort(c);
      },
      // Chat refreshes its own model list; there is nothing to refresh here.
      refreshModels: () => {},
      askUser: h.askUser,
      attach: (a) =>
        h.edit((s) => (s.attachments.some((x) => x.path === a.path) ? s : { ...s, attachments: [...s.attachments, a] })),
      setPlanProposal: (planProposal) => h.edit((s) => ({ ...s, planProposal })),
      setPastPlans: (fn) => h.edit((s) => ({ ...s, pastPlans: fn(s.pastPlans ?? []) })),
      setPlanAnchor: (planAnchor) => h.edit((s) => ({ ...s, planAnchor })),
      setPlanContext: (planContext) => h.edit((s) => ({ ...s, planContext })),
      setPlanSummary: (planSummary) => h.edit((s) => ({ ...s, planSummary })),
      changePlan: (plan) => {
        h.planRef.current = plan;
      },
      // The latest todos, for calls within one reply.
      todosRef: {
        get current() {
          return h.getSession().todos ?? [];
        },
        set current(todos) {
          h.edit((s) => ({ ...s, todos }));
        },
      },
      changeTodos: (todos) => h.edit((s) => ({ ...s, todos })),
      planRef: h.planRef,
      planRunningRef: h.planRunningRef,
      planAnchor: now.planAnchor ?? null,
      planContext: now.planContext ?? null,
      planSummary: now.planSummary ?? null,
    };

    const result = await runTurn(
      {
        connectorId: connector.id,
        kind: connector.kind,
        api: connector.api,
        model,
        toolsOn,
        thinkOn,
        planning,
        planStep,
        systemPrompt: toolContext.systemPrompt,
        toolDefinitions: toolContext.definitions,
        toolContextUpdate: toolContext.update,
        seenUpdate: seen ?? "",
        history: before.slice(start),
        forgotten,
        attached: attachedPaths(now.attachments),
        chatId: h.sessionId,
        controller,
        started,
        text,
      },
      callbacks,
    );

    // After a successful reply, ask the model to name the session if it has
    // no name yet. The rename is saved with the next save too, since the
    // session may not have a file yet for the rename to change.
    if (result.ok && !h.getSession().modelName) {
      const name = await askForSessionName(result.messages, connector.id, model, controller.signal, connector.api, connector.kind);
      if (name) {
        h.edit((s: Session) => ({ ...s, modelName: name, title: name }));
        renameSession(h.sessionId, { title: name, modelName: name }).catch(() => {});
      }
    }

    return { ok: result.ok, messages: result.messages, error: result.error };
  };
}
