// Shows a sent message in the history at once, then does the slow part (saving
// the session, uploading images, telling the server). If that doesn't go, the
// messages shown before come back. Kept apart from Chat so the order can be
// tested without rendering.
export type OptimisticSend<M> = {
  before: M[];
  message: M;
  // What was shown before the send (not `before`: on Resend `before` lacks the
  // message being retried).
  prior: M[];
  setMessages: (messages: M[]) => void;
  // Whether the chat is still the one on screen.
  canShow: () => boolean;
  // Whether to put `prior` back: false once the server's copy of the session
  // has arrived and replaced what was shown.
  canRestore: () => boolean;
  // The slow part. Resolves to whether the message went; a failure resolves to
  // false (it handles its own errors).
  work: () => Promise<boolean>;
};

export async function optimisticSend<M>(o: OptimisticSend<M>): Promise<boolean> {
  if (o.canShow()) o.setMessages([...o.before, o.message]);
  let went = false;
  try {
    went = await o.work();
  } finally {
    if (!went && o.canRestore()) o.setMessages(o.prior);
  }
  return went;
}
