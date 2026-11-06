// What a runner and its reply share. Types only, so the reply (runnerReply.ts)
// and a runner (the server's, server/runners.ts) can both use them without
// either importing the other. No React in this file.

import type { AccessRequest, Approval, AttachmentTarget, Picked, Connector, Model, PlanStep, Session, ToolContext } from "./api.ts";

// What a tool call can wait on the user for, and their answer: allow or deny,
// or, for a path, the files or folders they picked in its place.
export type Ask =
  | { needsAccess: AccessRequest }
  | { needsLocation: { description: string; kind: AttachmentTarget["kind"]; canSetWorkingDir?: boolean } }
  | { needsApproval: Approval };
export type Answer = boolean | Picked[];

// What a run needs besides the session. Kept by the runner, never saved. The
// connector is the server's list entry (`hasKey`, never the key itself).
export interface RunnerEnv {
  connector: Connector | null;
  model: string;
  models: Model[];
  toolContext: ToolContext;
  toolsOn: boolean;
  thinkOn: boolean;
  // Settings → Tools, "Fresh context for each plan step"; on unless false.
  freshSteps?: boolean;
}

// What a reply needs from its runner: the live session, a way to change it,
// and the run's ask and abort handling.
export interface RunnerHandle {
  sessionId: string;
  env: RunnerEnv;
  getSession: () => Session;
  edit: (fn: (s: Session) => Session) => void;
  setError: (err: string | null) => void;
  setAbort: (c: AbortController | null) => void;
  askUser: (ask: Ask, signal: AbortSignal) => Promise<Answer>;
  // True while runPlan runs; the plan tool reads it (see planFromCall).
  planRunningRef: { current: boolean };
  planRef: { current: PlanStep[] | null };
  // Reads an image file from disk, for base64 encoding in the reply (see
  // runnerReply.ts). Injected by the runner so src/ is shared with the browser.
  readImage?: (sessionId: string, imageId: string) => Promise<Buffer>;
}
