import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appPersonasDir, loadPersonas, parsePersonaFile, personasDir } from "../personas.ts";

// Every test reads a temp folder of its own; nothing writes to the app's personas folder.
const good = (name: string, extra = "") => `---\nname: ${name}\ndescription: About ${name}\n${extra}---\nDo it like ${name}.\n`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "personas-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const put = (files: Record<string, string>) => Promise.all(Object.entries(files).map(([f, t]) => writeFile(path.join(dir, f), t)));

describe("loadPersonas", () => {
  it("reads a good file: name, description and the body as instructions", async () => {
    await put({ "Builder.md": good("Builder") });
    expect(await loadPersonas(dir)).toEqual({
      personas: [{ name: "Builder", description: "About Builder", instructions: "Do it like Builder.", file: "Builder.md" }],
      problems: [],
    });
  });

  it("takes quoted values and ignores header fields it doesn't know", async () => {
    await put({ "Builder.md": good("Builder"), "a.md": "---\nname: \"A\"\ndescription: 'Reads'\nmodel: big\ntools: x\n---\nbody" });
    const { personas, problems } = await loadPersonas(dir);
    expect(problems).toEqual([]);
    expect(personas.find((p) => p.name === "A")).toEqual({ name: "A", description: "Reads", instructions: "body", file: "a.md" });
  });

  it("skips a file with no header or no name, with a plain message", async () => {
    await put({ "Builder.md": good("Builder"), "a.md": "just text", "b.md": "---\ndescription: x\n---\nbody" });
    const { personas, problems } = await loadPersonas(dir);
    expect(personas.map((p) => p.name)).toEqual(["Builder"]);
    expect(problems.map((p) => p.file)).toEqual(["a.md", "b.md"]);
    expect(problems[0].message).toMatch(/no header/);
    expect(problems[1].message).toMatch(/no name/);
  });

  it("skips a duplicate name (any case) and names the file that has it", async () => {
    await put({ "a.md": good("Builder"), "b.md": good("builder") });
    const { personas, problems } = await loadPersonas(dir);
    expect(personas.map((p) => p.file)).toEqual(["a.md"]);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/b\.md.*"builder".*a\.md already has/);
  });

  it("reads only .md files that aren't hidden", async () => {
    await put({ "Builder.md": good("Builder"), "notes.txt": good("Notes"), ".hidden.md": good("Hidden") });
    expect((await loadPersonas(dir)).personas.map((p) => p.name)).toEqual(["Builder"]);
  });

  it("says so when there is no usable Builder, since new chats start with it", async () => {
    await put({ "Builder.md": "no header" });
    const { personas, problems } = await loadPersonas(dir);
    expect(personas).toEqual([]);
    expect(problems.map((p) => p.message).join("\n")).toMatch(/no usable Builder\.md/);
  });

  it("a missing folder is no personas, and the missing Builder is the one problem", async () => {
    const { personas, problems } = await loadPersonas(path.join(dir, "nope"));
    expect(personas).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});

describe("the app's personas folder", () => {
  it("ships a Builder.md that loads with no problems", async () => {
    const { personas, problems } = await loadPersonas(appPersonasDir());
    expect(problems).toEqual([]);
    const builder = personas.find((p) => p.name === "Builder");
    expect(builder?.description).toBeTruthy();
    expect(builder?.instructions).toMatch(/^- Finish the work the user asked for/);
    expect(builder?.instructions).toContain("first call update_plan");
    expect(parsePersonaFile(await readFile(path.join(appPersonasDir(), "Builder.md"), "utf8"))?.fields.get("name")).toBe("Builder");
  });

  it("is the one read, unless a test names its own", () => {
    const prev = process.env.LLAMA_MUI_PERSONAS_DIR;
    try {
      delete process.env.LLAMA_MUI_PERSONAS_DIR;
      expect(personasDir()).toBe(appPersonasDir());
      process.env.LLAMA_MUI_PERSONAS_DIR = dir;
      expect(personasDir()).toBe(dir);
    } finally {
      if (prev === undefined) delete process.env.LLAMA_MUI_PERSONAS_DIR;
      else process.env.LLAMA_MUI_PERSONAS_DIR = prev;
    }
  });
});
