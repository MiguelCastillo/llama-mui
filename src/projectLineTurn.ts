// Which turn draws the project-instructions line: the first user message (not a
// side question, not a plan step) at or after the context start, so a context
// clear shows it again. Returns that turn's `start`, or undefined.
export function projectLineTurnStart(
  turns: { start: number; parts: { role: string; aside?: boolean; planStep?: unknown }[] }[],
  contextStart: number,
): number | undefined {
  return turns.find((t) => t.start >= contextStart && t.parts[0].role === "user" && !t.parts[0].aside && !t.parts[0].planStep)?.start;
}
