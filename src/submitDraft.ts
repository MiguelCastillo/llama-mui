// What the message box does around a send: it empties as soon as the send is
// accepted (not after the session is saved and the server told), and gets the
// text and images back if the send then fails. Kept apart from MessageBox so
// the order of these steps can be tested without rendering.
export type SubmitBox<I> = {
  text: string;
  images: I[];
  // Whether the chat the message was typed in is still the one on screen.
  stillShown: () => boolean;
  // Sends it; calls `accepted` once the send is certain to start. Resolves to
  // whether the message went.
  send: (accepted: () => void) => Promise<boolean>;
  // Empty the box (text, draft, images) without releasing the images' previews.
  clear: () => void;
  // Put the text and images back (and the draft).
  restore: () => void;
  // The message went: release the previews and drop the draft; `shown` says if
  // the box is still on that chat, which then empties.
  done: (shown: boolean) => void;
};

export async function submitDraft<I>(box: SubmitBox<I>): Promise<boolean> {
  let cleared = false;
  const accepted = () => {
    if (!box.stillShown()) return;
    cleared = true;
    box.clear();
  };
  const went = await box.send(accepted);
  if (went) box.done(box.stillShown());
  else if (cleared && box.stillShown()) box.restore();
  return went;
}
