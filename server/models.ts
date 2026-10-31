// Routes for per-model options (Settings → Models).

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { type ModelSettings, load, save } from "./store.ts";

const DEFAULTS: ModelSettings = { think: false };

// Handles /api/model-settings; returns false for anything else.
export async function modelSettingRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "model-settings" || parts.length !== 1) return false;

  // Only models someone changed are listed; the rest use DEFAULTS.
  if (method === "GET") {
    sendJson(res, 200, { defaults: DEFAULTS, models: (await load()).models });
    return true;
  }

  // The model id goes in the body since it contains "/" and ":".
  if (method === "PATCH") {
    const { model, ...changes } = await readJson(req);
    if (typeof model !== "string" || !model) throw new HttpError(400, "model is required");
    if (changes.think !== undefined && typeof changes.think !== "boolean") {
      throw new HttpError(400, "think must be true or false");
    }
    const store = await load();
    const merged = { ...DEFAULTS, ...store.models[model], ...(changes.think !== undefined && { think: changes.think }) };
    store.models[model] = merged;
    await save(store);
    sendJson(res, 200, merged);
    return true;
  }

  return false;
}
