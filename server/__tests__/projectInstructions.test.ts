import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_INSTRUCTION_FILES, RECOMMENDED_PROJECT_INSTRUCTIONS, readProjectInstructions, trusted } from "../projectInstructions.ts";

let dir = "";
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "llama-mui-project-")));
});
const put = (name: string, text: string) => writeFile(path.join(dir, name), text);

describe("readProjectInstructions", () => {
  it("reads AGENTS.md", async () => {
    await put("AGENTS.md", "Principle one.\n");
    expect(await readProjectInstructions(dir)).toEqual({ file: "AGENTS.md", text: "Principle one." });
  });

  it("reads only AGENTS.md: other context files are never loaded on their own", async () => {
    await put("CLAUDE.md", "From claude.");
    expect(await readProjectInstructions(dir)).toBeNull();
    await put("AGENTS.md", "agents");
    expect(await readProjectInstructions(dir)).toEqual({ file: "AGENTS.md", text: "agents" });
  });

  it("keeps the list of files as one named list, with AGENTS.md alone in it", () => {
    expect(PROJECT_INSTRUCTION_FILES).toEqual(["AGENTS.md"]);
  });

  it("does not follow an @file line in AGENTS.md: the text is used as it is", async () => {
    await writeFile(path.join(dir, "other.md"), "Other.");
    await put("AGENTS.md", "@other.md");
    expect(await readProjectInstructions(dir)).toEqual({ file: "AGENTS.md", text: "@other.md" });
  });

  it("returns a file over the recommended length whole and unchanged", async () => {
    const long = "x".repeat(RECOMMENDED_PROJECT_INSTRUCTIONS + 500);
    await put("AGENTS.md", long);
    expect(await readProjectInstructions(dir)).toEqual({ file: "AGENTS.md", text: long });
  });

  it("returns null, without throwing, for no file, an empty file, a folder, or no folder", async () => {
    expect(await readProjectInstructions(dir)).toBeNull();
    await put("AGENTS.md", "  \n");
    expect(await readProjectInstructions(dir)).toBeNull();
    await rm(path.join(dir, "AGENTS.md"));
    await mkdir(path.join(dir, "AGENTS.md"));
    expect(await readProjectInstructions(dir)).toBeNull();
    expect(await readProjectInstructions(path.join(dir, "nope"))).toBeNull();
    expect(await readProjectInstructions(undefined)).toBeNull();
    expect(await readProjectInstructions("")).toBeNull();
    expect(await readProjectInstructions("relative/dir")).toBeNull();
  });

  it("has a trust hook that trusts every folder for now", () => {
    expect(trusted(dir)).toBe(true);
  });
});
