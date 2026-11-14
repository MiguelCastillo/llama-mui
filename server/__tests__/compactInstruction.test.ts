import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactInstruction, compactInstructionFile } from "../compactInstruction.ts";

// The wording of the request for a compaction summary is a file of its own
// (prompts/compaction-instructions.md), shipped with the app. Tests that write a
// file use a folder of their own, never the real one.

const dirs: string[] = [];
const fileWith = async (text: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llama-mui-prompt-"));
  dirs.push(dir);
  const file = path.join(dir, "compaction-instructions.md");
  await writeFile(file, text);
  return file;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("the shipped compaction instructions", () => {
  it("are in prompts/ next to server/, and say what the summary is for", async () => {
    expect(compactInstructionFile()).toMatch(/prompts[\\/]compaction-instructions\.md$/);
    const text = await compactInstruction();
    expect(text.length).toBeGreaterThan(200);
    // The reader is the model itself, with no access to the messages above.
    expect(text).toContain("It replaces the older messages");
    // The headings the next messages depend on.
    for (const heading of ["Goal", "Where we are", "Decisions", "Not working", "Exact details", "Next"]) {
      expect(text, heading).toContain(`**${heading}:**`);
    }
    // The most recent part, which nothing keeps whole after a compaction.
    expect(text).toContain("most recent part in the most detail");
    expect(text).toContain("Copy error messages exactly");
    // Checked versus assumed, and carrying an earlier summary forward.
    expect(text).toContain("what you checked and what you only assumed");
    expect(text).toContain("earlier summary");
    // Text only: the tools stay in the request but may not run (see COMPACT_REFUSAL).
    expect(text).toContain("Don't use tools");
    expect(text).toContain("reply with the summary only");
  });

  it("is only the message: nothing in it addressed to people", async () => {
    const text = await compactInstruction();
    expect(text.startsWith("Please write a summary")).toBe(true);
    expect(text).not.toMatch(/^#/m);
  });
});

describe("compactInstruction", () => {
  it("returns the file's text without the blank lines around it", async () => {
    expect(await compactInstruction(await fileWith("\n\n  Write a summary.\n\n"))).toBe("Write a summary.");
  });

  it("reads the file each time, so a change applies to the next compaction", async () => {
    const file = await fileWith("First wording.");
    expect(await compactInstruction(file)).toBe("First wording.");
    await writeFile(file, "Second wording.");
    expect(await compactInstruction(file)).toBe("Second wording.");
  });

  it("says in plain words which file couldn't be read", async () => {
    const missing = path.join(os.tmpdir(), "llama-mui-no-such-prompt", "compaction-instructions.md");
    await expect(compactInstruction(missing)).rejects.toThrow(/couldn't be read from .*compaction-instructions\.md/);
  });

  it("refuses an empty file instead of sending an empty request", async () => {
    await expect(compactInstruction(await fileWith(" \n\n "))).rejects.toThrow(/file is empty/);
  });
});
