import { describe, expect, it } from "vitest";
import type { ChatMessage, Todo, ToolCall } from "../../api";
import { NOTE_KINDS } from "../../replyNoteKinds";
import { addNote, doItMessage, doItDisabled, doItPress, hasDoIt, hasDone, setNoteDone, ideaTodo, isNoteTool, noteBoxes, noteFromCall, noteLabel, notesOf, offersOf, planMessage, shownCalls, todoAdded, type NoteBox } from "../replyNotes";

const call = (name: string, args: object): ToolCall => ({ id: "t", name, arguments: JSON.stringify(args) });
const reply: ChatMessage = { role: "assistant", content: "Done." };
const box = (b: Partial<NoteBox> & Pick<NoteBox, "kind">): NoteBox => ({ text: "x", canDo: false, done: false, part: 0, note: 0, ...b });

describe("noteFromCall", () => {
  it("reads an idea, trimmed", () => {
    expect(noteFromCall(call("add_idea", { text: "  Try X \n now " }))).toEqual({ kind: "idea", text: "Try X now" });
  });

  it("reads an action item, with canDo only when the call says true", () => {
    expect(noteFromCall(call("add_action_item", { text: "Restart it", can_do: true }))).toEqual({ kind: "action", text: "Restart it", canDo: true });
    expect(noteFromCall(call("add_action_item", { text: "Restart it" }))).toEqual({ kind: "action", text: "Restart it" });
    expect(noteFromCall(call("add_action_item", { text: "Restart it", can_do: "yes" }))).toEqual({ kind: "action", text: "Restart it" });
  });

  it("ignores can_do on a kind that has no such argument", () => {
    expect(noteFromCall(call("add_idea", { text: "x", can_do: true }))).toEqual({ kind: "idea", text: "x" });
  });

  it("ignores bad JSON, blank text and other tools", () => {
    expect(noteFromCall({ id: "t", name: "add_idea", arguments: "{" })).toBeNull();
    expect(noteFromCall(call("add_idea", { text: "  " }))).toBeNull();
    expect(noteFromCall(call("add_action_item", {}))).toBeNull();
    expect(noteFromCall(call("add_todo", { text: "x" }))).toBeNull();
  });
});

describe("addNote", () => {
  it("adds notes to the reply in one list without touching the rest", () => {
    const a = addNote(reply, call("add_idea", { text: "One" }));
    const b = addNote(a, call("add_action_item", { text: "Do it", can_do: true }));
    expect(b).toEqual({ ...reply, notes: [{ kind: "idea", text: "One" }, { kind: "action", text: "Do it", canDo: true }] });
    expect(reply).toEqual({ role: "assistant", content: "Done." });
  });

  it("keeps each kind to its per-reply limit, as the table says", () => {
    let m = reply;
    for (const t of ["One", "Two", "Three"]) m = addNote(m, call("add_idea", { text: t }));
    expect(m.notes?.map((n) => n.text)).toEqual(["One", "Two"]);
    // The action kind has no limit.
    let a = reply;
    for (const t of ["a", "b", "c", "d"]) a = addNote(a, call("add_action_item", { text: t }));
    expect(a.notes).toHaveLength(4);
  });

  it("returns the same message for a call with no note", () => {
    expect(addNote(reply, call("add_idea", { text: "" }))).toBe(reply);
  });
});

describe("notesOf", () => {
  it("reads the notes list", () => {
    expect(notesOf({ ...reply, notes: [{ kind: "idea", text: "A" }] })).toEqual([{ kind: "idea", text: "A" }]);
  });

  it("skips what a saved file holds that is not a note", () => {
    const bad = { ...reply, notes: [null, { kind: "idea" }, { kind: 1, text: "x" }, { kind: "idea", text: "ok" }] } as unknown as ChatMessage;
    expect(notesOf(bad)).toEqual([{ kind: "idea", text: "ok" }]);
    expect(notesOf({ ...reply, notes: "no" } as unknown as ChatMessage)).toEqual([]);
    expect(notesOf(reply)).toEqual([]);
  });
});

describe("shownCalls", () => {
  it("leaves out the note tools", () => {
    const calls = [call("grep", {}), call("add_idea", { text: "x" }), call("add_action_item", { text: "y" }), call("add_todo", { text: "z" })];
    expect(shownCalls(calls).map((c) => c.name)).toEqual(["grep", "add_todo"]);
    expect(shownCalls(undefined)).toEqual([]);
  });
});

describe("noteBoxes", () => {
  it("groups by kind in the table's order, across the reply's messages", () => {
    const parts: ChatMessage[] = [
      { role: "assistant", content: "a", notes: [{ kind: "action", text: "Restart", canDo: true }] },
      { role: "assistant", content: "b", notes: [{ kind: "idea", text: "One" }, { kind: "action", text: "Check the log" }] },
    ];
    expect(noteBoxes(parts)).toEqual([
      { kind: "idea", text: "One", canDo: false, done: false, part: 1, note: 0 },
      { kind: "action", text: "Restart", canDo: true, done: false, part: 0, note: 0 },
      { kind: "action", text: "Check the log", canDo: false, done: false, part: 1, note: 1 },
    ]);
  });

  it("carries done for an action, and ignores it on a kind without that state", () => {
    const parts: ChatMessage[] = [
      { role: "assistant", content: "", notes: [{ kind: "idea", text: "A", done: true }, { kind: "action", text: "B", done: true }, { kind: "action", text: "C" }] },
    ];
    expect(noteBoxes(parts).map((b) => [b.text, b.done])).toEqual([["A", false], ["B", true], ["C", false]]);
  });

  it("points at each note by its message and its place in that message's notes, even past skipped ones", () => {
    const parts: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", notes: [{ kind: "idea", text: " " }, { kind: "action", text: "Real" }] },
    ];
    expect(noteBoxes(parts)).toEqual([{ kind: "action", text: "Real", canDo: false, done: false, part: 1, note: 1 }]);
  });

  it("shows at most each kind's limit, skips blank text, and ignores user messages", () => {
    const parts: ChatMessage[] = [
      { role: "user", content: "hi", notes: [{ kind: "idea", text: "Not mine" }] },
      {
        role: "assistant",
        content: "",
        notes: [
          { kind: "idea", text: "A" }, { kind: "idea", text: " " }, { kind: "idea", text: "B" }, { kind: "idea", text: "C" },
          { kind: "action", text: "  " },
        ],
      },
    ];
    expect(noteBoxes(parts)).toEqual([
      { kind: "idea", text: "A", canDo: false, done: false, part: 1, note: 0 },
      { kind: "idea", text: "B", canDo: false, done: false, part: 1, note: 2 },
    ]);
  });

  it("skips a kind the table doesn't have, and a canDo on a kind that can't offer it", () => {
    const parts: ChatMessage[] = [{ role: "assistant", content: "", notes: [{ kind: "tip", text: "?" }, { kind: "idea", text: "A", canDo: true }] }];
    expect(noteBoxes(parts)).toEqual([{ kind: "idea", text: "A", canDo: false, done: false, part: 0, note: 1 }]);
  });

  it("is empty for a reply with none", () => {
    expect(noteBoxes([reply])).toEqual([]);
  });
});

describe("the boxes' labels and button", () => {
  const idea = box({ kind: "idea", text: "x" });
  const can = box({ kind: "action", text: "y", canDo: true });
  const cannot = box({ kind: "action", text: "y" });

  it("labels each box with its kind's label from the table", () => {
    expect(noteLabel(idea)).toBe("Idea");
    expect(noteLabel(can)).toBe("Your action");
    for (const k of NOTE_KINDS) expect(noteLabel(box({ kind: k.id }))).toBe(k.label);
  });

  it("offers Do it only on a box the assistant could do", () => {
    expect(hasDoIt(can)).toBe(true);
    expect(hasDoIt(cannot)).toBe(false);
    expect(hasDoIt(idea)).toBe(false);
  });

  it("sends a yes that quotes the item, and is disabled while a reply streams", () => {
    expect(doItMessage(can)).toBe(`Yes, go ahead with this: ${can.text}`);
    expect(doItDisabled(true)).toBe(true);
    expect(doItDisabled(false)).toBe(false);
  });
});

describe("offersOf", () => {
  it("lists the buttons the kind's table row offers, and none for a kind without", () => {
    expect(offersOf(box({ kind: "idea" }))).toEqual(["todo", "plan"]);
    expect(offersOf(box({ kind: "action", canDo: true }))).toEqual([]);
    expect(offersOf(box({ kind: "tip" as any }))).toEqual([]);
  });

  it("matches the table: only kinds that set offers have buttons", () => {
    for (const k of NOTE_KINDS) expect(offersOf(box({ kind: k.id }))).toEqual(k.offers ?? []);
  });
});

describe("hasDone", () => {
  it("is true only for the action kind", () => {
    expect(hasDone("action")).toBe(true);
    expect(hasDone("idea")).toBe(false);
    expect(hasDone("tip")).toBe(false);
  });
});

describe("setNoteDone", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "a", notes: [{ kind: "idea", text: "One" }, { kind: "action", text: "Restart", canDo: true }, { kind: "action", text: "Check" }] },
    { role: "assistant", content: "b", notes: [{ kind: "action", text: "Other" }] },
  ];

  it("marks one note done and leaves everything else as it was", () => {
    const out = setNoteDone(messages, 1, 1, true);
    expect(out[1].notes).toEqual([{ kind: "idea", text: "One" }, { kind: "action", text: "Restart", canDo: true, done: true }, { kind: "action", text: "Check" }]);
    expect(out[0]).toBe(messages[0]);
    expect(out[2]).toBe(messages[2]);
    expect(out[1].content).toBe("a");
    expect(messages[1].notes?.[1]).toEqual({ kind: "action", text: "Restart", canDo: true });
  });

  it("opens it again, dropping the done mark", () => {
    const done = setNoteDone(messages, 2, 0, true);
    expect(done[2].notes).toEqual([{ kind: "action", text: "Other", done: true }]);
    const open = setNoteDone(done, 2, 0, false);
    expect(open[2].notes).toEqual([{ kind: "action", text: "Other" }]);
    expect("done" in open[2].notes![0]).toBe(false);
  });

  it("works from the box's place: its message's index and its note index", () => {
    const parts = messages.slice(1);
    const boxes = noteBoxes(parts);
    const check = boxes.find((b) => b.text === "Check")!;
    const out = setNoteDone(messages, 1 + check.part, check.note, true);
    expect(noteBoxes(out.slice(1)).map((b) => [b.text, b.done])).toEqual([["One", false], ["Restart", false], ["Check", true], ["Other", false]]);
  });

  it("returns the same list when nothing would change", () => {
    expect(setNoteDone(messages, 1, 0, true)).toBe(messages); // an idea has no done state
    expect(setNoteDone(messages, 1, 2, false)).toBe(messages); // already open
    expect(setNoteDone(setNoteDone(messages, 1, 2, true), 1, 2, true)).toEqual(setNoteDone(messages, 1, 2, true));
    const done = setNoteDone(messages, 1, 2, true);
    expect(setNoteDone(done, 1, 2, true)).toBe(done); // already done
    expect(setNoteDone(messages, 0, 0, true)).toBe(messages); // a user message
    expect(setNoteDone(messages, 9, 0, true)).toBe(messages); // no such message
    expect(setNoteDone(messages, 1, 9, true)).toBe(messages); // no such note
  });
});

describe("doItPress", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "a", notes: [{ kind: "idea", text: "One" }, { kind: "action", text: "Restart", canDo: true }] },
  ];

  it("sends, with the box marked done in the messages it builds on", () => {
    const press = doItPress(messages, 1, 1);
    expect(press.send).toBe(true);
    expect(press.messages[1].notes?.[1]).toEqual({ kind: "action", text: "Restart", canDo: true, done: true });
    expect(messages[1].notes?.[1].done).toBeUndefined();
  });

  it("does nothing on a second press, once the box is done", () => {
    const first = doItPress(messages, 1, 1);
    const second = doItPress(first.messages, 1, 1);
    expect(second.send).toBe(false);
    expect(second.messages).toBe(first.messages);
  });

  it("puts the box back to open when the send is refused", () => {
    const press = doItPress(messages, 1, 1);
    expect(setNoteDone(press.messages, 1, 1, false)).toEqual(messages);
  });

  it("sends without a mark on a kind that has no done state, and not at all for no such note", () => {
    const idea = doItPress(messages, 1, 0);
    expect(idea.send).toBe(true);
    expect(idea.messages).toBe(messages);
    expect(doItPress(messages, 1, 9).send).toBe(false);
    expect(doItPress(messages, 0, 0).send).toBe(false);
    expect(doItPress(messages, 7, 0).send).toBe(false);
  });
});

describe("ideaTodo", () => {
  it("uses the first sentence as the summary and the whole idea as the description", () => {
    const text = "Add a retry to the upload. It fails on slow networks and the user has to start again.";
    expect(ideaTodo(text, "abc12345", 99)).toEqual({
      id: "abc12345",
      summary: "Add a retry to the upload.",
      description: text,
      context: "",
      status: "open",
      createdAt: 99,
    });
  });

  it("keeps a short first sentence whole, whatever ends it", () => {
    expect(ideaTodo("Is it worth it? Maybe.", "i", 1).summary).toBe("Is it worth it?");
    expect(ideaTodo("Stop now! Really", "i", 1).summary).toBe("Stop now!");
    expect(ideaTodo("Use v2.5 of the tool. Then more.", "i", 1).summary).toBe("Use v2.5 of the tool.");
  });

  it("cuts a long first sentence to 80 characters at a word boundary", () => {
    const text = "Rewrite the settings page so that every option has a short help line under it and the layout stays the same on small screens.";
    const s = ideaTodo(text, "i", 1).summary;
    expect(s).toBe("Rewrite the settings page so that every option has a short help line under it");
    expect(s.length).toBeLessThanOrEqual(80);
    expect(text.startsWith(s)).toBe(true);
    expect(text[s.length]).toBe(" ");
  });

  it("keeps a word that ends exactly at the limit, and drops trailing punctuation after a cut", () => {
    const eighty = "a".repeat(40) + " " + "b".repeat(39);
    expect(eighty).toHaveLength(80);
    expect(ideaTodo(eighty + " more words", "i", 1).summary).toBe(eighty);
    expect(ideaTodo("a".repeat(30) + ", " + "b".repeat(60), "i", 1).summary).toBe("a".repeat(30));
  });

  it("cuts a single very long word at 80 characters", () => {
    expect(ideaTodo("x".repeat(120), "i", 1).summary).toBe("x".repeat(80));
  });

  it("uses the whole text when there is no sentence end", () => {
    expect(ideaTodo("  Try caching the model list \n for a minute  ", "i", 1)).toMatchObject({
      summary: "Try caching the model list for a minute",
      description: "Try caching the model list \n for a minute",
    });
  });
});

describe("todoAdded", () => {
  const todo = (description: string, status: Todo["status"]): Todo => ({ id: "t", summary: "s", description, context: "", status, createdAt: 1 });

  it("is true when an open todo has the idea as its description", () => {
    expect(todoAdded([todo("Try X", "open")], "Try X")).toBe(true);
    expect(todoAdded([todo("Try X", "open")], "  Try X ")).toBe(true);
  });

  it("is false for a done todo, another description, or no todos", () => {
    expect(todoAdded([todo("Try X", "done")], "Try X")).toBe(false);
    expect(todoAdded([todo("Try Y", "open")], "Try X")).toBe(false);
    expect(todoAdded([], "Try X")).toBe(false);
  });

  it("is true once an idea is added as a todo, and false again after that todo is done", () => {
    const added = [ideaTodo("Try X", "a", 1)];
    expect(todoAdded(added, "Try X")).toBe(true);
    expect(todoAdded(added.map((t) => ({ ...t, status: "done" as const })), "Try X")).toBe(false);
  });
});

describe("planMessage", () => {
  it("asks for a plan for the idea", () => {
    expect(planMessage("Try X")).toBe("Make a plan for this: Try X");
    expect(planMessage(" Try X ")).toBe("Make a plan for this: Try X");
  });
});

describe("isNoteTool", () => {
  it("is true for every tool in the table and no other", () => {
    for (const k of NOTE_KINDS) expect(isNoteTool(k.tool)).toBe(true);
    expect(isNoteTool("add_todo")).toBe(false);
  });
});
