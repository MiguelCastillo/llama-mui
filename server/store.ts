// The app's saved settings: llama servers (with their keys), which tools are
// turned off, per-model options, and chat display preferences. Lives in
// ~/.llama-mui/settings.json, next to the saved chats, readable only by you;
// only this server code touches it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Connector {
  id: string;
  name: string;
  url: string; // Server root, without /v1.
  apiKey: string;
}

export interface Preferences {
  showContextMeter: boolean;
  // Thoughts and tool calls inside replies.
  showSteps: boolean;
  // Formatting in messages; off shows the raw text.
  renderMarkdown: boolean;
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
  // Tools are on by default, so new ones show up enabled.
  disabledTools: string[];
  preferences: Preferences;
  models: Record<string, ModelSettings>;
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
  disabledTools: [],
  preferences: { showContextMeter: true, showSteps: true, renderMarkdown: true },
  models: {},
});

export async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    const base = empty();
    // Merge preferences key by key so ones added later get their defaults.
    return { ...base, ...raw, preferences: { ...base.preferences, ...raw.preferences } };
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  // Nothing in ~/.llama-mui yet: bring over the old file, if there is one.
  return (await moveOldSettings()) ? load() : empty();
}

// Write-then-rename so a crash mid-write can't leave a truncated file.
export async function save(store: Store): Promise<void> {
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, SETTINGS_FILE);
}