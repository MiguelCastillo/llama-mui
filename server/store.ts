// The app's saved settings: llama servers (with their keys), which tools are
// turned off, per-model options, and chat display preferences. Lives in settings.json, readable only by the owner,
// and only this server code touches it.

import { readFile, rename, writeFile } from "node:fs/promises";
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
export const SETTINGS_FILE = path.resolve("settings.json");

// A function, not a constant, so callers never share (and mutate) its arrays.
const empty = (): Store => ({
  activeId: null,
  connectors: [],
  disabledTools: [],
  preferences: { showContextMeter: true, showSteps: true },
  models: {},
});

export async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    const base = empty();
    // Merge preferences key by key so ones added later get their defaults.
    return { ...base, ...raw, preferences: { ...base.preferences, ...raw.preferences } };
  } catch (e: any) {
    if (e.code === "ENOENT") return empty();
    throw e;
  }
}

// Write-then-rename so a crash mid-write can't leave a truncated file.
export async function save(store: Store): Promise<void> {
  const tmp = `${SETTINGS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, SETTINGS_FILE);
}
