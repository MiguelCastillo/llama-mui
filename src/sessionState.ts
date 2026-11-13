import type {
  Attachment,
  AutoApprove,
  ChatMessage,
  PastPlan,
  PlanStep,
  PlanThread,
  QueuedMessage,
  Todo,
  Usage,
} from "./api.ts";
import type { Session } from "./api.ts";
import { shownFailure } from "./agent/helpers.ts";
import { cleanPersona } from "./persona.ts";
import type { CutState } from "./toolResults.ts";
import { withSessionDefaults } from "./sessionDefaults.ts";
import { newId } from "./uuid.ts";

// Everything about the open chat that is saved with it, in one object, so a
// save, a load and a "has anything changed" check each handle it as a whole.
// The field names are the saved session's (see Session in api.ts); what is not
// here is not saved: the chat's id, the model picker, the message box, scroll.
// Every field is always present: a loaded session's gaps are filled in by
// fromSession.
export interface SessionState {
  messages: ChatMessage[];
  // Index of the first message the model still sees (Clear context moves it).
  contextStart: number;
  // Extra files and folders the disk tools may read, besides the working directory.
  attachments: Attachment[];
  // Where relative paths and commands start; null is none.
  workingDir: string | null;
  // The working directory the system prompt names, fixed by the session's
  // first message. undefined until then: it follows workingDir.
  promptDir: string | null | undefined;
  // The persona's name, fixed once the first message is sent (see persona.ts).
  // undefined until chosen or set from the default at the first reply.
  persona: string | undefined;
  // The persona's text as the prompt has it (see Session.personaText).
  personaText: string | undefined;
  // Where the cut of old tool results stood, kept through the page's saves
  // (see Session.toolResultCut).
  toolResultCut: CutState | undefined;
  // Token count after the latest reply.
  usage: Usage | null;
  // Failure of the last reply only.
  failed: string | null;
  // The name the model gave the session (the user's own is never held here).
  modelName: string | null;
  // The task's steps, a change the model suggested to them, and the plan's
  // context, one-sentence summary and id.
  plan: PlanStep[] | null;
  planProposal: PlanStep[] | null;
  planContext: string | null;
  planSummary: string | null;
  planId: string | null;
  // Where the plan shows in the history: "at:N" or the id of the turn that wrote it.
  planAnchor: string | null;
  pastPlans: PastPlan[];
  // Things to come back to (add_todo).
  todos: Todo[];
  // The session this one is nested under, plans that moved out into their own
  // sessions, and the title until the model names the session.
  parentId: string | null;
  threads: PlanThread[];
  titleHint: string | null;
  // The plan came from the parent session and has not run yet.
  planMovedIn: boolean;
  // What is approved for the rest of the session without asking.
  autoApprove: AutoApprove;
  // Messages sent during a reply, waiting to be sent in order, and whether the
  // queue is waiting for the user (see Session). The server owns both: they are
  // held here so the chat shows them, and a save that carries them changes nothing.
  queue: QueuedMessage[];
  queuePaused: boolean;
}

// A new chat: nothing said, nothing planned.
export function emptySessionState(): SessionState {
  return {
    messages: [],
    contextStart: 0,
    attachments: [],
    workingDir: null,
    promptDir: undefined,
    persona: undefined,
    personaText: undefined,
    toolResultCut: undefined,
    usage: null,
    failed: null,
    modelName: null,
    plan: null,
    planProposal: null,
    planContext: null,
    planSummary: null,
    planId: null,
    planAnchor: null,
    pastPlans: [],
    todos: [],
    parentId: null,
    threads: [],
    titleHint: null,
    planMovedIn: false,
    autoApprove: {},
    queue: [],
    queuePaused: false,
  };
}

// What a session is compared by, to tell whether the server already holds it
// (see savedKey in Chat). It is built from the state's own fields, so a field
// added to the state is compared without being listed anywhere else, and
// the model and the connection. Not the id or the title: the title comes from the names and the
// first message, and a saved one holds the user's name, which saves never send.
// A field a session lacks counts as its empty value, so a session that left a
// field out and one that holds it empty are the same.
export function stateKey(session: Session): string {
  const empty = emptySessionState();
  const held = session as unknown as Record<string, unknown>;
  const keys = Object.keys(empty) as (keyof SessionState)[];
  return JSON.stringify([session.model, session.connectorId ?? null, ...keys.map((k) => held[k] ?? empty[k])]);
}

// The session as it is saved, built from the state.
export function toSession(
  state: SessionState,
  { id, model, connectorId }: { id: string; model: string; connectorId?: string | null },
): Session {
  const { autoApprove, ...rest } = state;
  const firstUser = state.messages.find((m) => m.role === "user")?.content ?? "New session";
  // The server puts the user's name, when there is one, ahead of this.
  return {
    id,
    title: state.modelName ?? state.titleHint ?? firstUser.slice(0, 80),
    model,
    // Left out when the chat has no connection, so such a session is saved as before.
    ...(connectorId ? { connectorId } : {}),
    ...rest,
    // Left out when nothing is approved, so a session without approvals is saved as before.
    ...(Object.keys(autoApprove).length ? { autoApprove } : {}),
  };
}

// The state a saved session opens as.
// `live`: the session is a run's, as it is now. A step that is running there
// really is, so it isn't reset to pending. `running`: that run has not ended,
// so the "interrupted" mark it keeps while a request is in flight is not shown
// as a failure (see shownFailure). `running` is `live` unless said otherwise.
export function fromSession(
  session: Session,
  { live = false, running = live }: { live?: boolean; running?: boolean } = {},
): SessionState {
  // Shared or older sessions may lack fields; each gets a default.
  const s = withSessionDefaults(session);
  // Saved before plans had a place: pinned after the chat's last message, where
  // they showed, so later messages go below them.
  const end = `at:${s.messages.length}`;
  return {
    messages: s.messages,
    contextStart: s.contextStart,
    attachments: s.attachments,
    workingDir: s.workingDir ?? null,
    promptDir: s.promptDir,
    persona: cleanPersona(s.persona),
    personaText: typeof s.personaText === "string" ? s.personaText : undefined,
    toolResultCut: s.toolResultCut,
    usage: s.usage,
    failed: shownFailure(s.failed, running),
    modelName: s.modelName ?? null,
    // A step that was running when the page went away didn't finish.
    plan:
      s.plan?.map((st) => ({
        ...st,
        id: st.id ?? newId(),
        status: st.status === "running" && !live ? "pending" : st.status,
      })) ?? null,
    planProposal: s.planProposal ?? null,
    planContext: s.planContext ?? null,
    planSummary: s.planSummary ?? null,
    planId: s.planId ?? null,
    planAnchor: s.plan ? (s.planAnchor ?? end) : null,
    pastPlans: (s.pastPlans ?? []).map((p) => ({ ...p, anchor: p.anchor ?? end })),
    todos: s.todos ?? [],
    parentId: s.parentId ?? null,
    threads: s.threads ?? [],
    titleHint: s.titleHint ?? null,
    planMovedIn: s.planMovedIn ?? false,
    autoApprove: s.autoApprove ?? {},
    queue: s.queue ?? [],
    queuePaused: s.queuePaused ?? false,
  };
}
