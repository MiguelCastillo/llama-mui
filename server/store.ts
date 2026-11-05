// The app's saved settings: llama servers, which tools are turned off,
// per-model options, and chat display preferences. Lives in
// ~/.llama-mui/settings.json, next to the saved sessions, readable only by you;
// only this server code touches it. The servers' API keys are not in that file:
// they are encrypted in ~/.llama-mui/.keys (see secrets.ts). A Connector has
// its `apiKey` in memory, filled in by load() and taken out again by save().

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openKeys, sealKeys } from "./secrets.ts";

export interface Connector {
  id: string;
  name: string;
  url: string; // Server root, without /v1.
  apiKey: string;
  // What's on the other end, which decides the client, the key's header and
  // what else there is: "llama", a llama.cpp server, with its model manager
  // (server/modelAdmin.ts); "anthropic", Anthropic's API. Missing, from
  // before there was a choice, means "llama".
  kind?: Kind;
  // For a llama server, which API chat speaks to it: Anthropic's Messages
  // (/v1/messages) or OpenAI's Chat Completions (/v1/chat/completions).
  // llama.cpp serves both. Missing means "anthropic"; Anthropic's API is
  // always "anthropic".
  api?: Api;
  // The model chat starts with on this server, chosen on the getting-started
  // page or in Settings → Models. Not a secret. Missing means no choice yet.
  defaultModel?: string;
}

export type Kind = "llama" | "anthropic";
export type Api = "anthropic" | "openai";

export interface Preferences {
  showContextMeter: boolean;
  // Thoughts and tool calls inside replies.
  showSteps: boolean;
  // Formatting in messages; off shows the raw text.
  renderMarkdown: boolean;
  // Each plan step starts with a fresh context (see runPlan in
  // src/agent/agent.ts). A switch while it's tested; meant to go away.
  freshPlanSteps: boolean;
}

// Options for one model, keyed by its id (e.g. "unsloth/Qwen3.5-9B-GGUF:Q4_K_M"),
// so they follow the model to any server that has it.
export interface ModelSettings {
  // Ask the chat template for a reasoning phase before the answer.
  think: boolean;
}

export interface Store {
  activeId: string | null;
  connectors: Connector[];
  // The master switch in Settings → Tools: off, no tool is offered, and each
  // tool's own setting below is kept for when it goes back on.
  toolsEnabled: boolean;
  // Tools are on by default, so new ones show up enabled.
  disabledTools: string[];
  preferences: Preferences;
  models: Record<string, ModelSettings>;
  // A command that checks a folder's code (a typecheck, tests), by the
  // folder's path; chat runs it after each plan step. See docs/guide.md,
  // "Running a plan".
  checkCommands: Record<string, string>;
}

// Exported so the file tools can refuse to read it: it holds API keys.
export const SETTINGS_FILE = path.join(os.homedir(), ".llama-mui", "settings.json");

// Where older versions kept settings: the folder the dev server started in.
const OLD_SETTINGS_FILE = path.resolve("settings.json");

// Moves settings from the old place, if there are any. True if it moved them.
async function moveOldSettings(): Promise<boolean> {
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true, mode: 0o700 });
  try {
    await rename(OLD_SETTINGS_FILE, SETTINGS_FILE);
    return true;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

// A function, not a constant, so callers never share (and mutate) its arrays.
const empty = (): Store => ({
  activeId: null,
  connectors: [],
  toolsEnabled: true,
  disabledTools: [],
  preferences: { showContextMeter: true, showSteps: true, renderMarkdown: true, freshPlanSteps: true },
  models: {},
  checkCommands: {},
});

// Ids of connectors whose saved key wouldn't open when a store was loaded, by
// store: save() keeps their entries instead of erasing a key that is only
// locked (say, LLAMA_MUI_SECRET_KEY wasn't set this time).
const locked = new WeakMap<Store, string[]>();

// Settings from the file, before the keys are put back (and with any key an
// older version left in the file, which load() moves out).
async function readSettings(): Promise<any> {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  // Nothing in ~/.llama-mui yet: bring over the old file, if there is one.
  return (await moveOldSettings()) ? readSettings() : null;
}

async function writeSettings(store: Store): Promise<void> {
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${SETTINGS_FILE}.tmp`;
  // The keys stay out of the file.
  const bare = { ...store, connectors: store.connectors.map(({ apiKey: _key, ...c }) => c) };
  await writeFile(tmp, JSON.stringify(bare, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, SETTINGS_FILE);
}

// Loads and saves run one at a time. Two requests at once would otherwise both
// move an old file's keys, or write the same temporary file.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export const load = (): Promise<Store> => exclusive(loadNow);

async function loadNow(): Promise<Store> {
  const raw = await readSettings();
  if (!raw) return empty();
  const base = empty();
  // The recent working directories were briefly kept here; they have their own file now.
  delete raw.recentFolders;
  const connectors: any[] = Array.isArray(raw.connectors) ? raw.connectors : [];
  const { keys, locked: lockedIds } = await openKeys();
  // Keys an older version left in the file: moved into .keys, read back to
  // check, and only then taken out of the file. They win over what .keys holds,
  // since only a version that didn't know about .keys could have written them.
  const legacy = connectors.filter((c) => typeof c.apiKey === "string" && c.apiKey);
  if (legacy.length > 0) {
    const merged = { ...keys, ...Object.fromEntries(legacy.map((c) => [c.id, c.apiKey])) };
    await sealKeys(merged, lockedIds);
    const back = (await openKeys()).keys;
    if (legacy.some((c) => back[c.id] !== c.apiKey)) throw new Error("Couldn't check the API keys after encrypting them; settings.json was left as it was.");
    Object.assign(keys, merged);
    await writeSettings({ ...base, ...raw, connectors, preferences: { ...base.preferences, ...raw.preferences } });
  }
  // Merge preferences key by key so ones added later get their defaults.
  const store: Store = {
    ...base,
    ...raw,
    connectors: connectors.map((c) => ({ ...c, apiKey: keys[c.id] ?? "" })),
    preferences: { ...base.preferences, ...raw.preferences },
  };
  locked.set(store, lockedIds);
  return store;
}

// Write-then-rename so a crash mid-write can't leave a truncated file. The keys
// are sealed first: a failure there leaves settings.json as it was.
export const save = (store: Store): Promise<void> => exclusive(() => saveNow(store));

async function saveNow(store: Store): Promise<void> {
  const keys = Object.fromEntries(store.connectors.filter((c) => c.apiKey).map((c) => [c.id, c.apiKey]));
  const ids = new Set(store.connectors.map((c) => c.id));
  await sealKeys(keys, (locked.get(store) ?? []).filter((id) => ids.has(id)));
  await writeSettings(store);
}
