// Notes on a reply (an idea, something left for the user): what the model's
// note tools put on its message. The server checked the call and answered
// (server/replyNotes.ts); chat records it here, on the reply, and shows it
// apart from the text. Which tools count, their labels and the per-reply cap
// come from the table in replyNoteKinds.ts. Never sent to the model as such:
// the call and its result are what the history keeps.

import type { ChatMessage, Todo, ToolCall } from "../api.ts";
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
// `done` is true when the user marked it done (only the kinds that have that
// state; see hasDone below). `part` is the index of the message in the reply's
// `parts`, `note` the index in that message's saved notes list: where to find
// the note again to change it (see setNoteDone).
export type NoteBox = { kind: NoteKindId; text: string; canDo: boolean; done: boolean; part: number; note: number };

// Whether a saved entry is a note (saved files can hold anything).
const isNote = (n: any): n is Note => typeof n?.kind === "string" && typeof n?.text === "string";

// Whether a kind can be marked done, as its table row says.
export const hasDone = (kind: string) => kindById(kind)?.hasDone === true;

// The messages with one note marked done (or open again, `done` false): the
// `message`-th of `messages`, its `noteIndex`-th saved note. Nothing else is
// touched; the same list comes back when there is no such note, its kind has no
// done state, or it already is as asked. A box's `part` counts only the reply's
// assistant messages (tool results sit between them in the session), so the
// caller finds `message` by looking that message up in the list; the box's
// `note` is the note index.
export function setNoteDone(messages: ChatMessage[], message: number, noteIndex: number, done: boolean): ChatMessage[] {
  const m = messages[message];
  if (!m || m.role !== "assistant" || !Array.isArray(m.notes)) return messages;
  const n = m.notes[noteIndex];
  if (!isNote(n) || !hasDone(n.kind) || (n.done === true) === done) return messages;
  const { done: _was, ...rest } = n;
  const notes = m.notes.map((x, i) => (i === noteIndex ? (done ? { ...rest, done: true } : rest) : x));
  return messages.map((x, i) => (i === message ? { ...m, notes } : x));
}

// What pressing "Do it" on a box does to the history: whether the message goes,
// and the messages to build it on (the box marked done, when its kind has that
// state). Nothing goes when the box is already done (a second press) or the
// note isn't at that place any more. `message` and `noteIndex` are as for
// setNoteDone. If the send is then refused, setNoteDone(..., false) puts the
// box back to open.
export function doItPress(messages: ChatMessage[], message: number, noteIndex: number): { send: boolean; messages: ChatMessage[] } {
  const m = messages[message];
  const n = m?.role === "assistant" && Array.isArray(m.notes) ? m.notes[noteIndex] : undefined;
  if (!isNote(n) || (hasDone(n.kind) && n.done === true)) return { send: false, messages };
  return { send: true, messages: setNoteDone(messages, message, noteIndex, true) };
}

// The boxes for one reply (its messages, in order): grouped by kind in the
// table's order, each kind capped at its per-reply limit. Blank text and kinds
// the table no longer has are skipped.
export function noteBoxes(parts: ChatMessage[]): NoteBox[] {
  const boxes: NoteBox[] = [];
  for (const kind of NOTE_KINDS) {
    const ofKind: NoteBox[] = [];
    parts.forEach((m, part) => {
      if (m.role !== "assistant" || !Array.isArray(m.notes)) return;
      m.notes.forEach((n, note) => {
        if (!isNote(n)) return;
        const text = n.text.trim();
        if (n.kind === kind.id && text) {
          ofKind.push({ kind: kind.id, text, canDo: canDoOf(kind) && n.canDo === true, done: hasDone(kind.id) && n.done === true, part, note });
        }
      });
    });
    boxes.push(...(kind.max === undefined ? ofKind : ofKind.slice(0, kind.max)));
  }
  return boxes;
}

// The label on a box.
export const noteLabel = (box: NoteBox) => kindById(box.kind)?.label ?? box.kind;

// What the "Do it" button sends as the next message: a yes that quotes the
// box's own text, so the model knows which item was approved.
export const doItMessage = (box: NoteBox) => `Yes, go ahead with this: ${box.text}`;

// Whether a box has a "Do it" button, and whether it can be pressed now (not
// while a reply streams: the server would refuse the message).
export const hasDoIt = (box: NoteBox) => box.canDo;
export const doItDisabled = (replyRunning: boolean) => replyRunning;

// ---- Turning an idea into a todo or a plan ----

// The buttons a box offers besides "Do it", as its kind's table row says.
export const offersOf = (box: NoteBox): NonNullable<NoteKind["offers"]> => kindById(box.kind)?.offers ?? [];

// A todo's summary is at most this long (the todo tool's limit).
export const TODO_SUMMARY_MAX = 80;

// The first sentence of a text, cut to `max` characters at a word boundary
// (a single word longer than that is cut where it hits the limit).
function firstSentence(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, " ");
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  // Keep the whole word if the limit falls exactly on its end.
  const atBoundary = sentence[max] === " ";
  const space = cut.lastIndexOf(" ");
  const words = atBoundary || space <= 0 ? cut : cut.slice(0, space);
  return words.replace(/[\s,;:\-–—]+$/, "");
}

// The todo an idea becomes: its first sentence as the summary, the whole idea
// as the description, no context. No model call is involved.
export const ideaTodo = (text: string, id: string, now: number): Todo => ({
  id,
  summary: firstSentence(text, TODO_SUMMARY_MAX),
  description: text.trim(),
  context: "",
  status: "open",
  createdAt: now,
});

// Whether an open todo already holds this idea (a done one doesn't count, so
// the idea can be added again).
export const todoAdded = (todos: Todo[], text: string): boolean => todos.some((t) => t.status === "open" && t.description === text.trim());

// What the "Make plan" button sends as the next message.
export const planMessage = (text: string) => `Make a plan for this: ${text.trim()}`;
