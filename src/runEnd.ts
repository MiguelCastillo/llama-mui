// Why a run's request was cut short. The kind is passed as the abort reason, so
// whatever sees the signal can read it back. Pure: no server or page code.
export const END_KINDS = ["stopped", "restart", "taken-over"] as const;
export type EndKind = (typeof END_KINDS)[number];

export const isEndKind = (v: unknown): v is EndKind => typeof v === "string" && (END_KINDS as readonly string[]).includes(v);

// The plain line shown under a reply that ended this way.
export const END_LINES: Record<EndKind, string> = {
  stopped: "You stopped this reply.",
  restart: "The server restarted during this reply.",
  "taken-over": "Another server took this over.",
};

// The button that goes with the line: Continue picks the work up again after an
// interruption nobody chose; nothing for a stop the user chose.
export const endButton = (kind: EndKind): "Continue" | null =>
  kind === "restart" || kind === "taken-over" ? "Continue" : null;

// The kind an abort signal carries, or null if it was aborted with no known reason.
export const endKindOf = (signal: AbortSignal | undefined | null): EndKind | null =>
  signal?.aborted && isEndKind(signal.reason) ? signal.reason : null;
