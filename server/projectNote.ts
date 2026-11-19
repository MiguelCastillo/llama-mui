// The note about a chat's project instructions: which file is loaded, and a
// gentle recommendation when it is long. Pure (no node imports) so the page
// and the server can both import it. The page draws it once, from the session's
// saved project instructions; it is never part of the chat update sent to the model.

// Not a cap: the whole file is always sent. Above this length the chat shows a
// gentle recommendation to keep the file shorter (never part of the prompt).
export const RECOMMENDED_PROJECT_INSTRUCTIONS = 20_000;

// The lines for a project file: "loaded", plus the recommendation when the text
// is longer than RECOMMENDED_PROJECT_INSTRUCTIONS. Empty when there is no file.
export function projectNoteLines(p: { file: string; text: string } | null | undefined): string[] {
  if (!p) return [];
  const loaded = `Project instructions loaded: ${p.file}`;
  if (p.text.length <= RECOMMENDED_PROJECT_INSTRUCTIONS) return [loaded];
  const count = p.text.length.toLocaleString("en-US");
  const limit = RECOMMENDED_PROJECT_INSTRUCTIONS.toLocaleString("en-US");
  return [loaded, `Project instructions are long (${count} characters); keeping ${p.file} under ${limit} is recommended.`];
}
