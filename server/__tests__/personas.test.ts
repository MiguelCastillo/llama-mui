import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    await put({ "Builder.md": good("Builder"), "a.md": "---\nname: \"A\"\ndescription: 'Reads'\nmodel: big\n---\nbody" });
    const { personas, problems } = await loadPersonas(dir);
    expect(problems).toEqual([]);
    expect(personas.find((p) => p.name === "A")).toEqual({ name: "A", description: "Reads", instructions: "body", file: "a.md" });
  });

  it("no tools field means no limit: the persona has no tools list", async () => {
    await put({ "Builder.md": good("Builder") });
    const { personas } = await loadPersonas(dir);
    expect(personas[0].tools).toBeUndefined();
  });

  it("reads a tools list of real tool names", async () => {
    await put({ "Builder.md": good("Builder"), "a.md": good("A", "tools: read_file, grep\n") });
    const { personas, problems } = await loadPersonas(dir);
    expect(problems).toEqual([]);
    expect(personas.find((p) => p.name === "A")?.tools).toEqual(["read_file", "grep"]);
  });

  it("drops an unknown tool name with a plain message, and the persona still loads", async () => {
    await put({ "Builder.md": good("Builder"), "a.md": good("A", "tools: read_file, read_fyle\n") });
    const { personas, problems } = await loadPersonas(dir);
    expect(personas.find((p) => p.name === "A")?.tools).toEqual(["read_file"]);
    expect(problems).toHaveLength(1);
    expect(problems[0].file).toBe("a.md");
    expect(problems[0].message).toMatch(/"read_fyle".*doesn't have/);
  });

  it("ignores extra spaces, empty items and repeats in the tools list", async () => {
    await put({ "Builder.md": good("Builder"), "a.md": good("A", "tools:   read_file ,, grep  ,read_file,\n") });
    const { personas, problems } = await loadPersonas(dir);
    expect(problems).toEqual([]);
    expect(personas.find((p) => p.name === "A")?.tools).toEqual(["read_file", "grep"]);
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
    expect(builder?.instructions).toContain("Light:");
    expect(builder?.instructions).toContain("Standard:");
    expect(builder?.instructions).toContain("update_plan");
    expect(parsePersonaFile(await readFile(path.join(appPersonasDir(), "Builder.md"), "utf8"))?.fields.get("name")).toBe("Builder");
  });

  it("lists only real tool names in every shipped file, so a typo or a renamed tool fails here", async () => {
    const { allToolNames } = await import("../tools.ts");
    const real = new Set(allToolNames());
    const files = (await readdir(appPersonasDir())).filter((n) => n.endsWith(".md"));
    expect(files).toEqual(expect.arrayContaining(["Builder.md", "Explainer.md", "Reviewer.md"]));
    for (const file of files) {
      const field = parsePersonaFile(await readFile(path.join(appPersonasDir(), file), "utf8"))?.fields.get("tools");
      const names = (field ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      for (const name of names) expect(real.has(name), `${file} lists "${name}"`).toBe(true);
      if (file === "Builder.md") expect(field).toBeUndefined();
      else expect(names.length).toBeGreaterThan(0);
    }
  });

  it("gives Explainer the read-only tools and Reviewer the same plus run_command", async () => {
    const { personas } = await loadPersonas(appPersonasDir());
    const readOnly = ["list_directory", "read_file", "find_files", "grep", "locate_path", "web_search", "fetch_url", "read_thread", "summarize_thread"];
    expect(personas.find((p) => p.name === "Explainer")?.tools).toEqual(readOnly);
    expect(personas.find((p) => p.name === "Reviewer")?.tools).toEqual([...readOnly, "run_command"]);
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
