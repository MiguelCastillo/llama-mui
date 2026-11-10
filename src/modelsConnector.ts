// Which connection the Models page shows. It is its own pick, kept in this
// browser, so changing the active connection in Settings doesn't move it.

const KEY = "llama-mui:models-connector";

// The connection to show: the saved one if it still exists, else the active
// one, else the first, else none.
export function pickModelsConnector<T extends { id: string }>(
  connectors: T[],
  activeId: string | null,
  savedId: string | null,
): T | null {
  return (
    connectors.find((c) => c.id === savedId) ??
    connectors.find((c) => c.id === activeId) ??
    connectors[0] ??
    null
  );
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
