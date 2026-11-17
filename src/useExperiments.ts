import { useEffect, useState } from "react";
import { type Experiments, getExperiments, updateExperiments } from "./api";

// Loads the Experimental switches (null until they arrive) and returns them
// with a function to change some. Errors go to onError, so the caller decides
// where to show them. Like usePreferences, for the switches in Settings → Models.
export function useExperiments(onError: (message: string) => void) {
  const [experiments, setExperiments] = useState<Experiments | null>(null);

  useEffect(() => {
    getExperiments()
      .then(setExperiments)
      .catch((e) => onError(e.message));
    // Only on mount.
  }, []);

  const set = (changes: Partial<Experiments>) => {
    // Flip it right away; the server's answer either confirms it or puts it back.
    setExperiments((x) => x && { ...x, ...changes });
    updateExperiments(changes)
      .then(setExperiments)
      .catch((e) => {
        onError(e.message);
        getExperiments().then(setExperiments);
      });
  };

  return [experiments, set] as const;
}
