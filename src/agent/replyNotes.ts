// Notes on a reply (an idea, something left for the user): what the model's
// note tools put on its message. The server checked the call and answered
// (server/replyNotes.ts); chat records it here, on the reply, and shows it
// apart from the text. Which tools count, their labels and the per-reply cap
// come from the table in replyNoteKinds.ts. Never sent to the model as such:
// the call and its result are what the history keeps.

import type { ChatMessage, ToolCall } from "../api.ts";
import { kindById, kindOfTool, NOTE_KINDS, NOTE_TOOL_NAMES, type NoteKind, type NoteKindId } from "../replyNoteKinds.ts";

export const isNoteTool = (name: string) => NOTE_TOOL_NAMES.has(name);

// One note, as saved on a reply.
export type Note = NonNullable<ChatMessage["notes"]>[number];

// What a call says to show: one note, or nothing when the arguments are not
// JSON or the text is blank.
export function noteFromCall(call: ToolCall): Note | null {
  const kind = kindOfTool(call.name);
  if (!kind) return null;
  let args: any;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return null;
  }
  const text = typeof args?.text === "string" ? args.text.trim().replace(/\s+/g, " ") : "";
  if (!text) return null;
  return { kind: kind.id, text, ...(canDoOf(kind) && args.can_do === true ? { canDo: true } : {}) };
}

// Only a kind with a can_do argument can offer the button.
const canDoOf = (kind: NoteKind) => !!kind.extraArgs?.can_do;

// The notes on one message, in a plain list. Saved files can hold anything, so
// each entry is checked to have a kind and a text.
export function notesOf(m: ChatMessage): Note[] {
  const out: Note[] = [];
  if (Array.isArray(m.notes)) {
    for (const n of m.notes) if (typeof n?.kind === "string" && typeof n?.text === "string") out.push(n);
  }
  return out;
}

// The reply with the call's note added; the same message when the call holds
// none or it is one note too many for its kind.
export function addNote(reply: ChatMessage, call: ToolCall): ChatMessage {
  const note = noteFromCall(call);
  if (!note) return reply;
  const have = notesOf(reply);
  const max = kindById(note.kind)?.max;
  if (max !== undefined && have.filter((n) => n.kind === note.kind).length >= max) return reply;
  return { ...reply, notes: [...have, note] };
}

// ---- Showing them (see MessageBubble in Chat.tsx) ----

// The calls a step row is drawn for: the note tools show as boxes under the
// reply instead.
export const shownCalls = (calls: ToolCall[] | undefined): ToolCall[] => (calls ?? []).filter((c) => !isNoteTool(c.name));

// One box under a finished reply. `canDo` is true only on a kind that can offer
// the "Do it" button, and only when the model said it could do the thing.
export type NoteBox = { kind: NoteKindId; text: string; canDo: boolean };

// The boxes for one reply (its messages, in order): grouped by kind in the
// table's order, each kind capped at its per-reply limit. Blank text and kinds
// the table no longer has are skipped.
export function noteBoxes(parts: ChatMessage[]): NoteBox[] {
  const boxes: NoteBox[] = [];
  for (const kind of NOTE_KINDS) {
    const ofKind: NoteBox[] = [];
    for (const m of parts) {
      if (m.role !== "assistant") continue;
      for (const n of notesOf(m)) {
        const text = n.text.trim();
        if (n.kind === kind.id && text) ofKind.push({ kind: kind.id, text, canDo: canDoOf(kind) && n.canDo === true });
      }
    }
    boxes.push(...(kind.max === undefined ? ofKind : ofKind.slice(0, kind.max)));
  }
  return boxes;
}

// The label on a box.
export const noteLabel = (box: NoteBox) => kindById(box.kind)?.label ?? box.kind;

// What the "Do it" button sends as the next message.
export const DO_IT_MESSAGE = "yes, go ahead";

// Whether a box has a "Do it" button, and whether it can be pressed now (not
// while a reply streams: the server would refuse the message).
export const hasDoIt = (box: NoteBox) => box.canDo;
export const doItDisabled = (replyRunning: boolean) => replyRunning;
