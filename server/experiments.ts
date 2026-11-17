// Routes for the experimental switches (Settings → Models, "Experimental").

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import type { Experiments } from "../src/api.ts";
import { EXPERIMENT_DEFAULTS, load, save } from "./store.ts";

// Handles /api/experiments; returns false for anything else. A partial update:
// send just the switches that changed. A key this version doesn't know is
// ignored (a newer page may send one), but a known key must be a boolean.
export async function experimentRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "experiments" || parts.length !== 1) return false;

  if (method === "GET") {
    sendJson(res, 200, (await load()).experiments);
    return true;
  }

  if (method === "PATCH") {
    const body = await readJson(req);
    const store = await load();
    for (const [key, value] of Object.entries(body)) {
      if (!(key in EXPERIMENT_DEFAULTS)) continue;
      if (typeof value !== "boolean") throw new HttpError(400, `Invalid experiment: ${key} must be true or false`);
      store.experiments[key as keyof Experiments] = value;
    }
    await save(store);
    sendJson(res, 200, store.experiments);
    return true;
  }

  return false;
}
