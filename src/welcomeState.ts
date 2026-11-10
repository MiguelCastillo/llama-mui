// Pure parts of the getting-started checklist: which steps are done, the
// hash marker that says the user came from it, and what's remembered in
// localStorage. Nothing here touches React, so tests can fake the app's state.

import type { Connector, Model } from "./api";

export interface WelcomeInput {
  // null: no server is set up. Anthropic connectors have nothing to load.
  connector: (Pick<Connector, "kind"> & { defaultModel?: string }) | null;
  // The latest connection test of that connector; undefined while it's running.
  connection: "ok" | "failed" | undefined;
  // That connection's models.
  models: Pick<Model, "id" | "status">[];
}

export interface WelcomeSteps {
  connect: boolean;
  choose: boolean;
}

// Whether a listed model can be used now. As in Chat's modelLoaded(), a
// server that doesn't report status has nothing to load, and Anthropic's
// models are always ready.
export const modelReady = (kind: Connector["kind"], m: Pick<Model, "status">) =>
  kind === "anthropic" || !m.status || m.status === "unknown" || m.status === "loaded";

// Step 2 is done when the connector has a default model, its server lists it
// and it's ready.
export function welcomeSteps({ connector, connection, models }: WelcomeInput): WelcomeSteps {
  const connect = !!connector && connection === "ok";
  if (!connect || !connector!.defaultModel) return { connect, choose: false };
  const m = models.find((m) => m.id === connector!.defaultModel);
  return { connect, choose: !!m && modelReady(connector!.kind, m) };
}

export const welcomeDone = (s: WelcomeSteps) => s.connect && s.choose;

// ── the marker on the hash address ───────────────────────────────────────────

export const WELCOME_MARKER = "from=welcome";

export const hasWelcomeMarker = (hash: string) => /[?&]from=welcome(?:&|$)/.test(hash);

// The checklist's own page.
export const WELCOME_HASH = "#/welcome";

// A settings address for a section, carrying the marker when asked.
export const settingsHash = (section: string, welcome = false) =>
  `#/settings/${section}${welcome ? `?${WELCOME_MARKER}` : ""}`;

// The banner's wording for the section the user is in.
export function welcomeBannerStep(section: string): string {
  if (section === "connectors") return "step 1: Connect a server";
  if (section === "models") return "step 2: Load a model";
  return "";
}

// ── what's remembered ────────────────────────────────────────────────────────

export const WELCOME_HIDDEN_KEY = "llama-mui:welcomeHidden";

export function welcomeHidden(): boolean {
  try {
    return localStorage.getItem(WELCOME_HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function setWelcomeHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(WELCOME_HIDDEN_KEY, "true");
    else localStorage.removeItem(WELCOME_HIDDEN_KEY);
  } catch {
    // Not remembered this time; the checklist is back on the next load.
  }
}

// Whether to send the user to the checklist when the app opens: only when
// the connector list has answered and shows no connector, and the checklist
// hasn't been exited or finished. A saved server that's down still counts.
export function welcomeRedirect({
  connectorCount,
  hidden,
}: {
  connectorCount: number | undefined;
  hidden: boolean;
}): "wait" | "redirect" | "stay" {
  if (connectorCount === undefined) return "wait";
  return connectorCount === 0 && !hidden ? "redirect" : "stay";
}

// What the connector dialog does once Save has stored the connector. From the
// checklist (the marker is on the address) it needs a passing test to go back;
// a failed one keeps the dialog open. Without the marker, Save just closes.
export function afterSave({
  marker,
  test,
}: {
  marker: boolean;
  test: { ok: boolean } | undefined;
}): "return" | "stay" | "close" {
  if (!marker) return "close";
  return test?.ok ? "return" : "stay";
}
