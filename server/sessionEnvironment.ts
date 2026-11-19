// The session environment: what a chat needs to start and keeps for its whole
// life. The server owns it; once set it is constant, and only an explicit user
// choice changes it (see AGENTS.md). This is the single list of its items: a
// new item is one more entry here, and later code and tests loop over it.

// The parts of a saved session the environment reads.
export interface EnvironmentSource {
  connectorId?: unknown;
  model?: unknown;
  workingDir?: unknown;
  attachments?: unknown;
  autoApprove?: unknown;
  persona?: unknown;
}

export interface EnvironmentItem {
  // The field's name in session.json.
  key: keyof EnvironmentSource;
  // Reads the stored value; undefined when the session has none.
  read: (s: EnvironmentSource) => unknown;
  // What the item is called in a message to the user.
  label: string;
  // Checks a value the user chose and returns what to store, or undefined if
  // it is not a valid value. Missing: the user can't change it after the chat
  // has started (the persona).
  choose?: (v: unknown) => unknown;
  // True: once the chat exists on disk a save never changes it, started or not;
  // only its own command does (approvals have one).
  commandOnly?: boolean;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export const ENVIRONMENT_ITEMS: readonly EnvironmentItem[] = [
  { key: "connectorId", label: "connection", read: (s) => text(s.connectorId), choose: text },
  { key: "model", label: "model", read: (s) => text(s.model), choose: text },
  // null is a real value (no working folder), so it is kept; only a missing field is undefined.
  { key: "workingDir", label: "working folder", read: (s) => (s.workingDir === null ? null : text(s.workingDir)), choose: (v) => (v === null ? null : text(v)) },
  {
    key: "attachments",
    label: "attached folders",
    read: (s) => (Array.isArray(s.attachments) ? s.attachments : undefined),
    choose: (v) => (Array.isArray(v) && v.every((a) => a && typeof a === "object" && text((a as { path?: unknown }).path)) ? v : undefined),
  },
  {
    key: "autoApprove",
    label: "approvals",
    commandOnly: true,
    read: (s) => (s.autoApprove && typeof s.autoApprove === "object" ? s.autoApprove : undefined),
    choose: (v) => (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "boolean") ? v : undefined),
  },
  { key: "persona", label: "persona", read: (s) => text(s.persona) },
];

export const ENVIRONMENT_KEYS: readonly string[] = ENVIRONMENT_ITEMS.map((i) => i.key);

// A chat has started once it has messages or a prompt folder (the same test as
// the persona's: see personaIsFixed in src/persona.ts).
export const hasStarted = (s: { messages?: unknown[]; promptDir?: unknown }): boolean =>
  (s.messages?.length ?? 0) > 0 || s.promptDir !== undefined;

// What a save does with the environment. A started chat keeps every stored
// item and ignores what the page sent (a stale or default value never changes
// it; a missing stored item stays missing). A chat not started takes what was
// sent. The persona is left out: personaToSave already decides it.
export function environmentForSave(
  old: (EnvironmentSource & { messages?: unknown[]; promptDir?: unknown }) | undefined,
  sent: EnvironmentSource,
): Record<string, unknown> {
  const keep = !!old && hasStarted(old);
  const out: Record<string, unknown> = {};
  for (const item of ENVIRONMENT_ITEMS) {
    if (item.key === "persona") continue;
    // Not started: the page's value, but an item it left out stays as stored
    // (the page no longer writes the model and connection of a chat the server has).
    const sentValue = item.read(sent);
    const value = keep || sentValue === undefined || (old && item.commandOnly) ? (old ? item.read(old) : undefined) : sentValue;
    if (value !== undefined) out[item.key] = value;
  }
  return out;
}

// What a brand-new chat starts with, picked once by the server when the chat is
// created: the connection last used (the newest chat's, if that connection
// still exists; else the first one), that connection's default model (none if
// it has none), and the default persona. Approvals and folders are not set here.
// `recent` is the saved sessions, newest first.
export function newChatEnvironment(input: {
  connectors: { id: string; defaultModel?: string }[];
  recent: EnvironmentSource[];
  persona?: string;
}): Record<string, unknown> {
  const used = input.recent.map((s) => text(s.connectorId)).find((id) => id && input.connectors.some((c) => c.id === id));
  const connector = input.connectors.find((c) => c.id === used) ?? input.connectors[0];
  const out: Record<string, unknown> = {};
  if (connector) out.connectorId = connector.id;
  if (connector?.defaultModel) out.model = connector.defaultModel;
  if (input.persona) out.persona = input.persona;
  return out;
}

// The stored environment of a session: only the items it has.
export function environmentOf(s: EnvironmentSource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of ENVIRONMENT_ITEMS) {
    const value = item.read(s);
    if (value !== undefined) out[item.key] = value;
  }
  return out;
}

// ---- What the log says about a change (see logEnvironment in sessions.ts) ----

export interface EnvironmentChange {
  item: string;
  // Only for the model, the connection and folder names; every other item is
  // named without values (approvals and persona never put their content in a log).
  from?: unknown;
  to?: unknown;
}

const base = (p: unknown) => (typeof p === "string" ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : p);

function loggable(key: string, value: unknown): unknown {
  if (key === "model" || key === "connectorId") return typeof value === "string" ? value : undefined;
  if (key === "workingDir") return value === null ? null : base(value);
  if (key === "attachments") return Array.isArray(value) ? value.map((a) => base((a as { path?: unknown })?.path)) : undefined;
  return undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Items whose value in `next` differs from the one stored in `old`.
export function environmentChanges(old: EnvironmentSource | undefined, next: EnvironmentSource): EnvironmentChange[] {
  const out: EnvironmentChange[] = [];
  for (const item of ENVIRONMENT_ITEMS) {
    const to = item.read(next);
    if (to === undefined) continue;
    const from = old ? item.read(old) : undefined;
    if (same(from, to)) continue;
    const f = loggable(item.key, from);
    const t = loggable(item.key, to);
    out.push({ item: item.key, ...(f !== undefined ? { from: f } : {}), ...(t !== undefined ? { to: t } : {}) });
  }
  return out;
}
