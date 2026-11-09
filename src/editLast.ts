// Which message the up arrow can take back to edit. Pure, no React.

import type { ChatMessage, ImageRef } from "./api.ts";
import { isAside } from "./asides.ts";

export interface EditableMessage {
  // Position in the messages array.
  index: number;
  text: string;
  // The images the message was sent with; kept when it is replaced.
  images: ImageRef[];
}

// The last message the user sent in the chat itself: not a side question, not
// a prompt a plan step made. Null while a plan runs or a reply streams (the
// user would be cutting a turn that is still going), or when there is none.
export function lastEditable(
  messages: ChatMessage[],
  planRunning: boolean,
  replyRunning: boolean,
): EditableMessage | null {
  if (planRunning || replyRunning) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const m = messages[index];
    if (m.role !== "user" || isAside(m) || m.planStep) continue;
    return { index, text: m.content, images: m.images ?? [] };
  }
  return null;
}
