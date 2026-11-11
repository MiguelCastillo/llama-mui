import type { Capabilities } from "./connections/index.ts";

// What the model picker shows beside a model, from its capabilities: one small
// icon for each thing it can do, only when its server says it can (a model
// that says nothing shows nothing, never a "no"), and a note for a Claude model
// Anthropic has deprecated. The context size is already on the picker's second line.
export type Badge = "images" | "pdf" | "thinking";

export const BADGE_TITLES: Record<Badge, string> = {
  images: "Reads images",
  pdf: "Reads PDFs",
  thinking: "Thinks before answering",
};

export function badgesOf(caps: Capabilities | undefined): Badge[] {
  const out: Badge[] = [];
  if (caps?.images === true) out.push("images");
  if (caps?.pdf === true) out.push("pdf");
  if (caps?.thinking === true) out.push("thinking");
  return out;
}

// "Retires 2026-12-01" or "Deprecated", for a model Anthropic is retiring.
export function lifecycleNote(caps: Capabilities | undefined): string | undefined {
  if (!caps?.deprecated) return undefined;
  const date = caps.retiresAt?.slice(0, 10);
  return date ? `Deprecated, retires ${date}` : "Deprecated";
}
