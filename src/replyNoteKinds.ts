// The kinds of note the model can put under a reply (an idea, something left
// for the user to do). Plain data, no React and no imports, so the server (the
// tool specs and help text) and chat (recording and showing them) read the same
// table. To add a kind: add a row here, and give it a style where chat draws
// the boxes (Chat.tsx). The tool, its help and the loop pick it up from here.

// A note is a sentence or two, not a paragraph.
export const MAX_NOTE_CHARS = 400;

// What the server answers the model after a valid call.
export const NOTE_SHOWN_ANSWER = "Shown to the user.";

export type NoteKindId = "idea" | "action";

export type NoteKind = {
  id: NoteKindId;
  // The tool the model calls.
  tool: string;
  // One sentence, no overlap with another kind: when to use the tool. Written
  // without the closing full stop and without the per-reply limit: both are
  // added by `noteDescription`.
  description: string;
  // The tool's name and one-liner in Settings → Tools.
  toolLabel: string;
  toolSummary: string;
  // Arguments besides `text`, as JSON-schema properties (all optional).
  extraArgs?: Record<string, { type: string; description: string }>;
  // The label on the box under the reply.
  label: string;
  // At most this many per reply; more are dropped. No limit when absent.
  max?: number;
};

export const NOTE_KINDS: readonly NoteKind[] = [
  {
    id: "idea",
    tool: "add_idea",
    description:
      "Suggest something the user didn't ask for, only when it's worth their time, as one plain sentence",
    toolLabel: "Add an idea",
    toolSummary: "Show the user an idea under your reply, apart from the text.",
    label: "Idea",
    max: 2,
  },
  {
    id: "action",
    tool: "add_action_item",
    description:
      "Hand the user something that is left for them after your work and that only they can do or approve, as one plain sentence, not for steps you can take now",
    toolLabel: "Add an action item",
    toolSummary: "Show the user something left for them to do, under your reply.",
    extraArgs: {
      can_do: {
        type: "boolean",
        description:
          "True if you could do it yourself with the user's approval (they get a button to say yes); false if only they can. Default false.",
      },
    },
    label: "Your action",
  },
];

// The sentence the model reads: the description plus the per-reply limit.
export const noteDescription = (k: NoteKind): string =>
  `${k.description}${k.max ? `, at most ${k.max} per reply` : ""}.`;

export const NOTE_TOOL_NAMES: ReadonlySet<string> = new Set(NOTE_KINDS.map((k) => k.tool));

// The kind a tool name belongs to, or undefined for any other tool.
export const kindOfTool = (tool: string): NoteKind | undefined => NOTE_KINDS.find((k) => k.tool === tool);

export const kindById = (id: string): NoteKind | undefined => NOTE_KINDS.find((k) => k.id === id);
