// The "dangerous commands" setting (Settings → Tools): whether commands in the
// list always ask, which built-in entries are switched off, and the user's own
// entries. See src/dangerousCommands.ts for the list itself and for why this is
// a stand-in and not a sandbox.
//
// The server reads it fresh at each decision (readForDecision) and never takes
// it from the page or the model. Reading fails closed: the check is off only
// when the file was read and `enabled` is exactly false.

import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { load, save } from "./store.ts";
import { BUILT_IN_ENTRIES, MAX_CUSTOM_ENTRIES, customEntryProblem, type CustomEntry } from "../src/dangerousCommands.ts";

export interface DangerousCommandsSetting {
  enabled: boolean;
  // Ids of built-in entries switched off.
  off: string[];
  custom: CustomEntry[];
  // Fields this version doesn't know are kept as they are.
  [unknown: string]: unknown;
}

export const dangerousDefaults = (): DangerousCommandsSetting => ({ enabled: true, off: [], custom: [] });

// What a saved value means. Anything unusable falls back to "on", never "off":
// only a boolean false turns the check off. Unknown fields are kept.
export function normalizeDangerous(raw: unknown): DangerousCommandsSetting {
  const base = dangerousDefaults();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const known = new Set(BUILT_IN_ENTRIES.map((e) => e.id));
  return {
    ...r,
    enabled: r.enabled !== false,
    off: Array.isArray(r.off) ? [...new Set(r.off.filter((x): x is string => typeof x === "string" && known.has(x)))] : [],
    custom: Array.isArray(r.custom) ? r.custom.filter((c) => customEntryProblem(c) === undefined).map(({ id, label, pattern }: any) => ({ id, label: label ?? id, pattern })) : [],
  };
}

// The setting to decide with. Settings that can't be read mean undefined, and
// undefined means the check is on.
export async function readForDecision(): Promise<DangerousCommandsSetting | undefined> {
  try {
    return normalizeDangerous((await load()).dangerousCommands);
  } catch {
    return undefined;
  }
}

// Checks a setting sent to be saved; throws a 400 with a plain message.
export function validateDangerous(body: unknown, current: DangerousCommandsSetting): DangerousCommandsSetting {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send the setting as an object.");
  const b = body as Record<string, unknown>;
  const next = { ...current };
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    next.enabled = b.enabled;
  }
  if ("off" in b) {
    const known = new Set(BUILT_IN_ENTRIES.map((e) => e.id));
    if (!Array.isArray(b.off) || b.off.some((x) => typeof x !== "string")) throw new HttpError(400, "off must be a list of entry ids.");
    const unknown = (b.off as string[]).find((x) => !known.has(x));
    if (unknown) throw new HttpError(400, `"${unknown}" isn't a built-in entry, so it can't be switched off.`);
    next.off = [...new Set(b.off as string[])];
  }
  if ("custom" in b) {
    if (!Array.isArray(b.custom)) throw new HttpError(400, "custom must be a list of entries.");
    if (b.custom.length > MAX_CUSTOM_ENTRIES) throw new HttpError(400, `At most ${MAX_CUSTOM_ENTRIES} custom entries.`);
    const ids = new Set<string>();
    for (const c of b.custom) {
      const problem = customEntryProblem(c);
      if (problem) throw new HttpError(400, problem);
      const { id, label, pattern } = c as CustomEntry;
      if (ids.has(id)) throw new HttpError(400, `Two custom entries share the id "${id}".`);
      ids.add(id);
    }
    next.custom = (b.custom as CustomEntry[]).map(({ id, label, pattern }) => ({ id, label: label || id, pattern }));
  }
  return next;
}

// Handles /api/dangerous-commands; returns false for anything else.
export async function dangerousCommandRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "dangerous-commands" || parts.length !== 1) return false;

  if (method === "GET") {
    sendJson(res, 200, normalizeDangerous((await load()).dangerousCommands));
    return true;
  }

  // Partial update: send just the fields that changed.
  if (method === "PUT" || method === "PATCH") {
    const body = await readJson(req);
    const store = await load();
    const next = validateDangerous(body, normalizeDangerous(store.dangerousCommands));
    store.dangerousCommands = next;
    await save(store);
    sendJson(res, 200, next);
    return true;
  }

  return false;
}
