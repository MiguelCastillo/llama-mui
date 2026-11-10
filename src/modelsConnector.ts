// The connection last used, kept in this browser. The Models page opens on it
// and keeps its own pick there; no connection is "active" for the whole app.

const KEY = "llama-mui:models-connector";

// The connection to use: the remembered one if it still exists, else the
// first, else none.
export function pickModelsConnector<T extends { id: string }>(connectors: T[], savedId: string | null): T | null {
  return connectors.find((c) => c.id === savedId) ?? connectors[0] ?? null;
}

export function getSavedModelsConnectorId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSavedModelsConnectorId(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not kept this time; the pick still works until the page reloads.
  }
}
