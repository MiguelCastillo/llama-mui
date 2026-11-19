import type { Kind, Model } from "./api";
import { connection } from "./connections";
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

// The model and connection a chat shows once the server has answered for it
// (the same for a run's copy as for a saved one): exactly what the server
// stored. A chat stored without a model shows none; the previous chat's model
// is never carried over.
export function choiceFromSession(s: { model?: string | null; connectorId?: string | null }): {
  model: string;
  connectorId: string | null;
} {
  return { model: s.model || "", connectorId: s.connectorId || null };
}

// The model offered when the user moves a chat to another connection: that
// connection's own default, if it lists it, else none (the chat's model is then
// left as stored and the user picks). A list never chooses a model otherwise:
// it only fills the menu, and there is no fallback to a loaded or first model.
export function defaultIfListed(defaultModel: string | undefined, models: Pick<Model, "id">[]): string {
  return defaultModel && models.some((m) => m.id === defaultModel) ? defaultModel : "";
}

// What a model list does to the chat's model menu: it becomes the options and
// nothing else. The chosen model comes back exactly as it was, whether the
// list holds it or not, and whether the list came before or after the chat's
// answer (a list that came first leaves the choice empty until the answer).
export function afterModelList<M extends Pick<Model, "id">>(chosen: string, listed: M[]): { options: M[]; chosen: string } {
  return { options: listed, chosen };
}

// The menu's own value: the chosen model only when it is one of the options
// (MUI warns about a value that isn't), else none.
export function menuValue(loaded: boolean, chosen: string, options: Pick<Model, "id">[]): string {
  return loaded && options.some((m) => m.id === chosen) ? chosen : "";
}

// The stored model the connection does not list, or null. Only a list that was
// read successfully for this chat's connection counts (`listRead` is that
// connection's id): no list yet, a list that failed, a chat that has not
// answered or a chat with no model say nothing, since unknown is never "not
// listed". Whether an id is listed is the connection's answer.
export function unlistedModel(
  kind: Kind | undefined,
  s: { loaded: boolean; connectorId: string | null; listRead: string | null; chosen: string; options: Pick<Model, "id">[] },
): string | null {
  if (!s.loaded || !s.chosen || !s.connectorId || s.listRead !== s.connectorId) return null;
  return connection(kind).listsModel(s.options, s.chosen) ? null : s.chosen;
}

// The name drawn in the closed menu: the chosen model as stored, listed or
// not; nothing until the chat has answered.
export function shownModel(loaded: boolean, chosen: string): string | null {
  return loaded ? chosen : null;
}

// What is wrong with the chat's connection, or null. "deleted": the chat
// stored a connection that is no longer in the list (`id` is the stored value;
// its name went with it). "unreachable": the connection exists but its last
// model list could not be read (`listFailed` is that connection's id). A chat
// that has not answered, or a connection list not read yet, says nothing:
// unknown is never a problem. Nothing is switched in either case.
export function connectionProblem(s: {
  loaded: boolean;
  connectors: { id: string; name: string }[] | undefined;
  storedId: string | null;
  listFailed: string | null;
}): { kind: "deleted"; id: string } | { kind: "unreachable"; id: string; name: string } | null {
  if (!s.loaded || !s.connectors || !s.storedId) return null;
  const found = s.connectors.find((c) => c.id === s.storedId);
  if (!found) return { kind: "deleted", id: s.storedId };
  if (s.listFailed === found.id) return { kind: "unreachable", id: found.id, name: found.name };
  return null;
}
