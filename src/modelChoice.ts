import type { Model } from "./api";
import { pickModelsConnector } from "./modelsConnector";

// The connection a chat is on, from the connections there are now. A chat that
// saved one keeps it, and if that one has been deleted the answer is null (the
// chat shows no connection and the user picks another; nothing is switched
// silently). A chat with none saved (a new one, or one saved before chats
// kept a connection) is on the last used connection, else the first.
export function connectionForChat<T extends { id: string }>(
  connectors: T[],
  savedId: string | null | undefined,
  lastUsedId: string | null,
): T | null {
  if (savedId) return connectors.find((c) => c.id === savedId) ?? null;
  return pickModelsConnector(connectors, lastUsedId);
}

// The model chat uses after loading a server's list: keep the current pick if
// the server lists it; else the connector's default model if it lists that;
// else one that's already loaded, so the first reply is fast; else the first.
// Picking in the chat menu never changes the default.
export function pickModel({
  current,
  defaultModel,
  models,
}: {
  current: string;
  defaultModel?: string;
  models: Pick<Model, "id" | "status">[];
}): string {
  const listed = (id?: string) => !!id && models.some((m) => m.id === id);
  if (listed(current)) return current;
  if (listed(defaultModel)) return defaultModel!;
  return (models.find((m) => m.status === "loaded") ?? models[0])?.id ?? "";
}
