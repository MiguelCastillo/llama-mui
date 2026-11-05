import { useEffect, useState } from "react";
import { type Preferences, getPreferences, updatePreferences } from "./api";

// Loads the preferences and returns them (null until they arrive) with a
// function to change some. Errors go to onError, so the caller decides where
// to show them.
export function usePreferences(onError: (message: string) => void) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);

  useEffect(() => {
    getPreferences()
      .then(setPrefs)
      .catch((e) => onError(e.message));
    // Only on mount.
  }, []);

  const set = (changes: Partial<Preferences>) => {
    // Flip it right away; the server's answer either confirms it or puts it back.
    setPrefs((p) => p && { ...p, ...changes });
    updatePreferences(changes)
      .then(setPrefs)
      .catch((e) => {
        onError(e.message);
        getPreferences().then(setPrefs);
      });
  };

  return [prefs, set] as const;
}
