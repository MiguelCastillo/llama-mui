import { useEffect, useState } from "react";
import { openAppEvents } from "./appEvents";
import { getWorkInProgress, type WorkEntry } from "./api";

export const WORK_REFRESH_MS = 15_000;

// Keeps `onEntries` current for one project folder: loads now, then every
// `everyMs` while the page is visible, when the page becomes visible again, and
// right after any run ends (the app event stream says a run is gone). A failed
// load keeps what was shown. Returns a function that stops all of it.
export function watchWorkInProgress(dir: string, onEntries: (entries: WorkEntry[]) => void, everyMs = WORK_REFRESH_MS): () => void {
  let stopped = false;
  let latest = 0;
  const load = () => {
    const mine = ++latest;
    getWorkInProgress(dir)
      .then((entries) => !stopped && mine === latest && onEntries(entries))
      .catch(() => {});
  };
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const tick = () => visible() && load();
  load();
  const timer = setInterval(tick, everyMs);
  const onVisibility = () => tick();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  const events = openAppEvents();
  const onStatus = (e: Event) => {
    try {
      // A status with no run means that run just ended.
      if (JSON.parse((e as MessageEvent).data).run === null) load();
    } catch {
      // not ours
    }
  };
  events?.source.addEventListener("status", onStatus);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    events?.source.removeEventListener("status", onStatus);
    events?.release();
  };
}

// The work in progress for the working folder; [] until it loads, with no
// folder, or when the folder isn't a git repo.
// Changing `reloadToken` loads the list again at once (a merge just ended).
export function useWorkInProgress(dir: string | null | undefined, reloadToken = 0): WorkEntry[] {
  const [entries, setEntries] = useState<WorkEntry[]>([]);
  useEffect(() => {
    setEntries([]);
  }, [dir]);
  useEffect(() => {
    if (!dir) return;
    return watchWorkInProgress(dir, setEntries);
  }, [dir, reloadToken]);
  return entries;
}
