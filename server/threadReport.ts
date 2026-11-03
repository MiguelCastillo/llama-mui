// A thread reports back: when the run of a thread (a nested session that holds
// a plan, see src/planThread.ts) ends, the session that started it learns how
// it went, without the thread's messages being copied there.
//
// The note in the parent (Session.threads) gets, in two writes:
//
//  1. at once: `status` (done, failed or unfinished, from the thread's saved
//     plan, see threadStatus) and no `report`, so the note stops spinning and
//     says how it ended, and an old report doesn't sit under a new status;
//  2. a moment later: `report`, one or two sentences. They come from one more
//     request to the model that ran the plan, with no tools, shown the plan,
//     its steps and the model's last words (see src/agent/threadReport.ts).
//     If the request fails, or the user stopped the run (they have had their
//     say, and a model that is slow or unloaded should not hold things up), the
//     report is a plain sentence made from the steps' statuses.
//
// Each write is an owner-edit (hub.edit): through the parent's live session if
// it has a run of its own, else on its file; it bumps the revision either way,
// and pages hear of it as `saved` and as a `thread` event
// { sessionId, planId?, status, report, revision } (report is null in the first).
// A parent with no note for this thread (a nested session made by hand), or one
// that has been deleted, is left alone. Nothing here throws to the runner: a
// report that can't be written is a warning in the server's log.
//
// No key is involved: the request goes through the server's own /api, where the
// proxy adds it (see setApiOrigin in src/api.ts).

import { type ReportInput, askForReport, fallbackReport } from "../src/agent/threadReport.ts";
import type { PlanThread, Session, ThreadOutcome } from "../src/api.ts";
import { threadStatus } from "../src/planThread.ts";
import type { RunnerEnv } from "../src/runnerTypes.ts";
import { HttpError } from "./http.ts";
import * as hub from "./runHub.ts";

// How a run ended, as the runner knows it.
export interface RunEnd {
  id: string;
  // The session as the run left it.
  session: Session;
  env: RunnerEnv;
  error: string | null;
  stopped: boolean;
}

// Asks the model for the report; null for "nothing useful". askForReport by
// default; a test passes a fake.
export type AskReport = (input: ReportInput, env: RunnerEnv, signal: AbortSignal) => Promise<string | null>;

export const askModel: AskReport = (input, env, signal) =>
  env.connector
    ? askForReport(input, env.connector.id, env.model, signal, env.connector.api, env.connector.kind)
    : Promise.resolve(null);

// How long the model has to write the report before the plain sentence is used.
export const REPORT_TIMEOUT_MS = 60_000;

// Thrown inside the edit when the parent has no note for the thread, which
// stops the edit before anything is written.
class NoNote extends Error {}

// Sets the note's status and report (no report: gone). Returns false if the
// parent has no such note or no longer exists.
async function writeNote(parentId: string, end: RunEnd, status: ThreadOutcome, report: PlanThread["report"]): Promise<boolean> {
  let planId: string | undefined;
  try {
    const { revision } = await hub.edit(parentId, (parent) => {
      const threads: PlanThread[] = Array.isArray(parent.threads) ? parent.threads : [];
      const note = threads.find((t) => t.sessionId === end.id);
      if (!note) throw new NoNote();
      planId = note.planId;
      const { report: _old, ...rest } = note;
      parent.threads = threads.map((t) => (t === note ? { ...rest, status, ...(report ? { report } : {}) } : t));
    });
    hub.publish({
      type: "thread",
      id: parentId,
      data: { sessionId: end.id, ...(planId ? { planId } : {}), status, report: report ?? null, revision },
    });
    return true;
  } catch (e) {
    if (e instanceof NoNote || (e instanceof HttpError && e.status === 404)) return false;
    throw e;
  }
}

// The report's text: the model's, or the plain sentence.
async function reportText(end: RunEnd, input: ReportInput, ask: AskReport): Promise<string> {
  if (!end.stopped) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
    try {
      const text = await ask(input, end.env, controller.signal);
      if (text) return text;
    } catch {
      // the plain sentence below
    } finally {
      clearTimeout(timer);
    }
  }
  return fallbackReport(input);
}

// Tells the thread's parent how the run ended. Call it once the run is over
// and the thread's final session is saved. Resolves when both writes are done.
export async function reportToParent(end: RunEnd, ask: AskReport = askModel): Promise<void> {
  const parentId = end.session.parentId;
  if (typeof parentId !== "string" || !parentId) return;
  try {
    const status = threadStatus(end.session);
    if (status === "missing") return;
    if (!(await writeNote(parentId, end, status, undefined))) return;

    const steps = end.session.plan ?? [];
    const input: ReportInput = {
      summary: end.session.planSummary?.trim() || end.session.title,
      request: end.session.messages.find((m) => m.role === "user" && !m.planStep)?.content,
      steps,
      messages: end.session.messages,
      error: end.error,
      stopped: end.stopped,
    };
    const text = await reportText(end, input, ask);
    await writeNote(parentId, end, status, { text, at: Date.now() });
  } catch (e) {
    console.warn(`Couldn't report on thread ${end.id} to session ${parentId}: ${e}`);
  }
}
