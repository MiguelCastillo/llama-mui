// Notes the model attaches to its reply (ideas, action items), shown apart from
// the reply text. What kinds there are, their tool names and descriptions come
// from one table (src/replyNoteKinds.ts); this file turns each row into a tool.
// Like update_plan and add_todo, the server only checks the call and answers the
// model; chat records it on the reply (src/agent). Not offered to side
// questions (see aside.ts): they only get read-only tools.

import { MAX_NOTE_CHARS, NOTE_KINDS, NOTE_SHOWN_ANSWER, type NoteKind, noteDescription } from "../src/replyNoteKinds.ts";
import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

// The help text for the group: one line per kind, from its description, then
// what holds for all of them.
export const replyNoteInstructions =
  NOTE_KINDS.map((k) => `${k.tool}: ${noteDescription(k)}`).join("\n") +
  "\nEach is shown to the user in its own box under your reply, so don't repeat it in your reply text, " +
  "and your reply ends after the call. " +
  "Call a note tool only once you have what you need from other tools, because your reply ends after it " +
  "and you won't see the results of anything else called in the same round.";

// The cleaned text of a note call, or a ToolError saying what to fix.
export function checkNote(args: any): string {
  const text = typeof args?.text === "string" ? args.text.trim().replace(/\s+/g, " ") : "";
  if (!text) throw new ToolError("text is required: one plain sentence");
  if (text.length > MAX_NOTE_CHARS) {
    throw new ToolError(`text is ${text.length} characters; shorten it to under ${MAX_NOTE_CHARS} and call again`);
  }
  return text;
}

function toolFor(kind: NoteKind): ToolSpec {
  return {
    name: kind.tool,
    group: "replyNotes",
    label: kind.toolLabel,
    summary: kind.toolSummary,
    definition: fn(kind.tool, noteDescription(kind), {
      type: "object",
      properties: {
        text: { type: "string", description: `One plain sentence, under ${MAX_NOTE_CHARS} characters.` },
        ...kind.extraArgs,
      },
      required: ["text"],
    }),
    async run(_ctx, args) {
      checkNote(args);
      return NOTE_SHOWN_ANSWER;
    },
  };
}

export const REPLY_NOTE_TOOLS: ToolSpec[] = NOTE_KINDS.map(toolFor);
