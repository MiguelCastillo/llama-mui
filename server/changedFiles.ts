// A small hand-off point: the file-change wrapper (io/fs.ts) tells whoever
// registered here that a chat changed a file, in a call of its own, apart from
// the audit line. The run hub registers itself and keeps the list in the run
// record, so a restart's note can read it from there. Nothing here reads or
// writes the audit.

type Sink = (session: string, path: string) => void;

let sink: Sink | null = null;

export function setChangedFileSink(next: Sink | null): void {
  sink = next;
}

// Never throws: a failure to note a file must not break the change itself.
export function noteChangedFile(session: string, path: string): void {
  try {
    sink?.(session, path);
  } catch {
    // Best effort.
  }
}
