// Routes for per-model options (Settings → Models).

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { type ModelSettings, load, save } from "./store.ts";
import { checkOptions } from "./modelOptions.ts";

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
    const { model, connectorId, ...changes } = await readJson(req);
    if (typeof model !== "string" || !model) throw new HttpError(400, "model is required");
    // null or "" clears effort, so the model's own default applies.
    const clearEffort = changes.effort === null || changes.effort === "";
    if (clearEffort) delete changes.effort;
    // Checked by the connection the model is on (connectorId, when given):
    // its kind says which settings exist, and for Claude the model's own
    // capabilities say which effort levels. Without a connection, by shape.
    const checked = await checkOptions(typeof connectorId === "string" ? connectorId : undefined, model, {
      think: changes.think,
      effort: changes.effort,
    });
    // A setting the kind doesn't have is not saved, but was not an error to send;
    // one that was sent and is wrong threw above.
    const store = await load();
    const merged: ModelSettings = {
      ...DEFAULTS,
      ...store.models[model],
      ...(checked.think !== undefined && { think: checked.think }),
      ...(checked.effort !== undefined && { effort: checked.effort }),
    };
    if (clearEffort) delete merged.effort;
    store.models[model] = merged;
    await save(store);
    sendJson(res, 200, merged);
    return true;
  }

  return false;
}
