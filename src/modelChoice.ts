import type { Model } from "./api";

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
