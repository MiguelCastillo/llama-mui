// Routes for chat display preferences (Settings → Chat).

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { type Preferences, load, save } from "./store.ts";

// Only known keys of the right type are saved, so a bad request can't put
// junk in settings.json.
const VALIDATORS: Record<keyof Preferences, (v: unknown) => boolean> = {
  showContextMeter: (v) => typeof v === "boolean",
  showSteps: (v) => typeof v === "boolean",
  renderMarkdown: (v) => typeof v === "boolean",
  freshPlanSteps: (v) => typeof v === "boolean",
};

// Handles /api/preferences; returns false for anything else.
export async function preferenceRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "preferences" || parts.length !== 1) return false;

  if (method === "GET") {
    sendJson(res, 200, (await load()).preferences);
    return true;
  }

  // Partial update: send just the keys that changed.
  if (method === "PATCH") {
    const body = await readJson(req);
    const store = await load();
    for (const [key, value] of Object.entries(body)) {
      const valid = VALIDATORS[key as keyof Preferences];
      if (!valid?.(value)) throw new HttpError(400, `Invalid preference: ${key}`);
      (store.preferences as any)[key] = value;
    }
    await save(store);
    sendJson(res, 200, store.preferences);
    return true;
  }

  return false;
}
