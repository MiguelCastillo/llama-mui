import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const { toolRoutes } = await import("../tools.ts");
const { skillsPromptText } = await import("../skills.ts");

const prompt = async () => {
  const req = Readable.from([Buffer.from(JSON.stringify({ attachments: [], promptDir: "/work" }))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "context"], method: "POST", search: "" });
  return JSON.parse(text).systemPrompt as string;
};

afterEach(() => {
  delete process.env.LLAMA_MUI_SKILLS_DIR;
});

describe("skills in the system prompt", () => {
  it("lists a skill's name and description but not its instructions", async () => {
    const root = await mkdtemp(path.join(home.dir, "skills-"));
    await mkdir(path.join(root, "pdf"));
    await writeFile(
      path.join(root, "pdf", "SKILL.md"),
      "---\nname: pdf-forms\ndescription: Fill in PDF forms\n---\nSECRET-BODY-TEXT\n",
    );
    process.env.LLAMA_MUI_SKILLS_DIR = root;
    const text = await prompt();
    expect(text).toContain("- pdf-forms: Fill in PDF forms");
    expect(text).toContain("load_skill");
    expect(text).not.toContain("SECRET-BODY-TEXT");
  });

  it("adds nothing when there are no skills", async () => {
    process.env.LLAMA_MUI_SKILLS_DIR = path.join(home.dir, "no-such-folder");
    expect(await prompt()).not.toContain("Skills available");
    expect(skillsPromptText([])).toBe("");
  });
});
