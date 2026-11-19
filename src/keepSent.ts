// A message just sent stays on screen until the server's copy of the session
// holds it. The page shows it at once (optimisticSend.ts); a running reply's
// first updates can come from before the server added it, and drawing one took
// the message off the page for about 100 ms and put it back lower, so the
// pinned view snapped (seen in scroll traces). Pure, so it can be tested.

export type SentMessage = {
  session: string;
  /** Its place in the list: the number of messages before it. */
  index: number;
  content: string;
  /** When it was sent (ms), so a copy that never holds it stops being held off. */
  at: number;
};

/** How long a copy without the sent message is held off at most, in ms. */
export const KEEP_SENT_MS = 15_000;

type Msg = { role: string; content: unknown };

/**
 * Whether `incoming` holds the sent message at its place: a user message
 * there. The text isn't compared: the server may store it trimmed or as parts
 * (images), and a copy from before the send is simply shorter.
 */
export function holdsSent(incoming: readonly Msg[], sent: SentMessage): boolean {
  return incoming[sent.index]?.role === "user";
}

/**
 * What to do with a server copy while a sent message is waiting: "take" it
 * (it holds the message, or nothing is waiting, or the wait is over), or
 * "keep" the list on screen for now.
 */
export function keepOrTake(incoming: readonly Msg[], sent: SentMessage | null, session: string, now: number): "take" | "keep" {
  if (!sent || sent.session !== session) return "take";
  if (now - sent.at > KEEP_SENT_MS) return "take";
  return holdsSent(incoming, sent) ? "take" : "keep";
}
