import { useCallback, useEffect, useRef, useState } from "react";
import { approveMerge, discardMerge, getMerge, startMerge, type MergeAttemptState } from "./api";

export const MERGE_POLL_MS = 2000;

const RUNNING = ["replaying", "checking"];
export const mergeIsRunning = (a: MergeAttemptState | null) => !!a && RUNNING.includes(a.state);

export interface MergeController {
  start(branch: string): Promise<void>;
  approve(): Promise<void>;
  discard(): Promise<void>;
  stop(): void;
}

// Drives one merge attempt for a project folder. `onChange` gets every new
// state (or an error message in place of one); `onEnded` is called when the
// attempt stops running (ready, failed, conflict, merged, discarded...) so the
// work-in-progress list can reload. While replaying or checking it asks for the
// state every `everyMs`.
export function createMergeController(
  dir: string,
  onChange: (state: MergeAttemptState | null, error: string | null) => void,
  onEnded: () => void,
  everyMs = MERGE_POLL_MS,
): MergeController {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let id: string | null = null;

  const fail = (e: unknown) => !stopped && onChange(null, (e as Error)?.message ?? String(e));
  const apply = (s: MergeAttemptState) => {
    if (stopped) return;
    id = s.id;
    onChange(s, null);
    if (RUNNING.includes(s.state)) timer = setTimeout(poll, everyMs);
    else onEnded();
  };
  const poll = () => {
    if (stopped || !id) return;
    getMerge(id).then(apply, fail);
  };
  const act = async (fn: (id: string) => Promise<MergeAttemptState>) => {
    if (!id) return;
    try {
      const s = await fn(id);
      if (stopped) return;
      onChange(s, null);
      onEnded();
    } catch (e) {
      fail(e);
    }
  };
  return {
    async start(branch) {
      clearTimeout(timer);
      onChange(null, null);
      try {
        apply(await startMerge(dir, branch));
      } catch (e) {
        fail(e);
      }
    },
    approve: () => act(approveMerge),
    discard: () => act(discardMerge),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// One merge attempt for the working folder. `onEnded` is called when the attempt
// stops running or is approved/discarded; use it to reload the list.
export function useMergeAttempt(dir: string | null | undefined, onEnded: () => void) {
  const [attempt, setAttempt] = useState<MergeAttemptState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const ctl = useRef<MergeController | null>(null);

  useEffect(() => {
    setAttempt(null);
    setError(null);
    if (!dir) return;
    const c = createMergeController(
      dir,
      (s, e) => {
        setAttempt(s);
        setError(e);
      },
      () => ended.current(),
    );
    ctl.current = c;
    return () => {
      c.stop();
      ctl.current = null;
    };
  }, [dir]);

  const start = useCallback((branch: string) => ctl.current?.start(branch), []);
  const approve = useCallback(() => ctl.current?.approve(), []);
  const discard = useCallback(() => ctl.current?.discard(), []);
  // Hides a finished attempt (a conflict, an error, a merge that went through).
  const dismiss = useCallback(() => {
    setAttempt(null);
    setError(null);
  }, []);
  return { attempt, error, running: mergeIsRunning(attempt), start, approve, discard, dismiss };
}
