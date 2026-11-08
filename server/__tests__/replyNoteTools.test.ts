import { describe, expect, it } from "vitest";
import { NOTE_KINDS, NOTE_SHOWN_ANSWER, noteDescription } from "../../src/replyNoteKinds.ts";
import { REPLY_NOTE_TOOLS, checkNote, replyNoteInstructions } from "../replyNotes.ts";
import { ToolError, type ToolContext } from "../toolkit.ts";

const ctx = { store: {}, chatId: "c", attachments: [], approved: null, todos: [] } as unknown as ToolContext;
const tool = (name: string) => REPLY_NOTE_TOOLS.find((t) => t.name === name)!;

describe("the table of kinds", () => {
  it("gives every kind one tool, in the replyNotes group, with its own name", () => {
    expect(REPLY_NOTE_TOOLS.map((t) => t.name)).toEqual(NOTE_KINDS.map((k) => k.tool));
    expect(REPLY_NOTE_TOOLS.map((t) => t.name)).toEqual(["add_idea", "add_action_item"]);
    for (const t of REPLY_NOTE_TOOLS) expect(t.group).toBe("replyNotes");
  });

  it("takes each tool's description, limit and extra arguments from its row", () => {
    for (const k of NOTE_KINDS) {
      const def: any = tool(k.tool).definition;
      expect(def.function.description).toBe(noteDescription(k));
      expect(def.function.parameters.required).toEqual(["text"]);
      expect(Object.keys(def.function.parameters.properties)).toEqual(["text", ...Object.keys(k.extraArgs ?? {})]);
    }
    const idea: any = tool("add_idea").definition;
    expect(idea.function.description).toMatch(/at most 2 per reply/);
    const action: any = tool("add_action_item").definition;
    expect(action.function.description).not.toMatch(/at most/);
    expect(action.function.parameters.properties.can_do.type).toBe("boolean");
  });

  it("lists every kind in the help text and keeps one-sentence descriptions", () => {
    for (const k of NOTE_KINDS) {
      expect(replyNoteInstructions).toContain(k.tool);
      expect(noteDescription(k).match(/[.!?](\s|$)/g)).toHaveLength(1);
    }
  });

  it("answers the model with the table's one-line answer", async () => {
    expect(NOTE_SHOWN_ANSWER).toBe("Shown to the user.");
    for (const k of NOTE_KINDS) expect(await tool(k.tool).run(ctx, { text: "Hello" })).toBe(NOTE_SHOWN_ANSWER);
  });
});

describe("add_idea", () => {
  it("answers the model in one line for a valid call", async () => {
    expect(await tool("add_idea").run(ctx, { text: "Try a bigger model" })).toBe("Shown to the user.");
  });

  it("refuses blank or missing text", async () => {
    await expect(tool("add_idea").run(ctx, { text: "  " })).rejects.toThrow(/text is required/);
    await expect(tool("add_idea").run(ctx, {})).rejects.toThrow(ToolError);
  });

  it("refuses over-long text", async () => {
    await expect(tool("add_idea").run(ctx, { text: "x".repeat(401) })).rejects.toThrow(/shorten it to under 400/);
    expect(checkNote({ text: "x".repeat(400) })).toHaveLength(400);
  });
});

describe("add_action_item", () => {
  it("answers the model in one line for a valid call", async () => {
    expect(await tool("add_action_item").run(ctx, { text: "Restart the server", can_do: true })).toBe("Shown to the user.");
  });

  it("refuses blank or over-long text", async () => {
    await expect(tool("add_action_item").run(ctx, { text: "" })).rejects.toThrow(/text is required/);
    await expect(tool("add_action_item").run(ctx, { text: "x".repeat(401) })).rejects.toThrow(ToolError);
  });
});

describe("checkNote", () => {
  it("trims and collapses whitespace", () => {
    expect(checkNote({ text: "  Try   it \n now " })).toBe("Try it now");
  });
});
