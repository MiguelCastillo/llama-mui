import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The home folder is pointed at a temp one first: these tests must never touch
// the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { toolRoutes, allToolNames, personaRefusal } = await import("../tools.ts");
const { loadPersonas } = await import("../personas.ts");

let root = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(home.dir, "skills-"));
  await mkdir(path.join(root, "pdf"));
  await writeFile(
    path.join(root, "pdf", "SKILL.md"),
    "---\nname: pdf-forms\ndescription: Fill in PDF forms\n---\nStep one: open the form.\n",
  );
  await mkdir(path.join(root, "sql"));
  await writeFile(path.join(root, "sql", "SKILL.md"), "---\nname: sql-help\ndescription: Write SQL\n---\nUse CTEs.\n");
});

afterEach(() => {
  delete process.env.LLAMA_MUI_SKILLS_DIR;
});

const call = async (args: object) => {
  const body = { name: "load_skill", arguments: args, chatId: "k", attachments: [] };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "call"], method: "POST", search: "" });
  return JSON.parse(text);
};

describe("load_skill", () => {
  it("returns the instructions and the skill's folder", async () => {
    process.env.LLAMA_MUI_SKILLS_DIR = root;
    const out = await call({ name: "pdf-forms" });
    expect(out.result).toContain("Step one: open the form.");
    expect(out.result).toContain(path.join(root, "pdf"));
  });

  it("names the available skills when the name is unknown", async () => {
    process.env.LLAMA_MUI_SKILLS_DIR = root;
    const out = await call({ name: "nope" });
    expect(out.result).toMatch(/^Error: there is no skill named "nope"/);
    expect(out.result).toContain("pdf-forms");
    expect(out.result).toContain("sql-help");
  });

  it("says so when there are no skills at all", async () => {
    process.env.LLAMA_MUI_SKILLS_DIR = path.join(home.dir, "no-such-folder");
    expect((await call({ name: "x" })).result).toContain("No skills are available");
  });

  it("runs without asking for approval or access", async () => {
    process.env.LLAMA_MUI_SKILLS_DIR = root;
    const out = await call({ name: "sql-help" });
    expect(Object.keys(out)).toEqual(["result"]);
  });
});

describe("a persona with a tools list", () => {
  it("can name load_skill, and is refused it when not named", async () => {
    expect(allToolNames()).toContain("load_skill");
    const dir = await mkdtemp(path.join(home.dir, "personas-"));
    await writeFile(path.join(dir, "Reader.md"), "---\nname: Reader\ndescription: x\ntools: read_file, load_skill\n---\nRead.");
    await writeFile(path.join(dir, "Other.md"), "---\nname: Other\ndescription: x\ntools: read_file\n---\nRead.");
    const { personas, problems } = await loadPersonas(dir);
    expect(problems.filter((p) => p.file === "Reader.md")).toEqual([]);
    const reader = personas.find((p) => p.name === "Reader")!;
    const other = personas.find((p) => p.name === "Other")!;
    expect(reader.tools).toEqual(["read_file", "load_skill"]);
    expect(personaRefusal("load_skill", reader)).toBeNull();
    expect(personaRefusal("load_skill", other)).toContain("not available");
  });
});
