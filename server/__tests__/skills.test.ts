import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills, skillSources } from "../skills.ts";

// Every test builds its own folder under the system temp folder; the real
// ~/.llama-mui is never read.
const tmp = () => mkdtemp(path.join(os.tmpdir(), "llama-mui-skills-"));

async function skill(root: string, folder: string, text: string) {
  await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, folder, "SKILL.md"), text);
}

describe("loadSkills", () => {
  it("reads name, description and instructions, and ignores unknown fields", async () => {
    const root = await tmp();
    await skill(root, "pdf", "---\nname: pdf-forms\ndescription: Fill PDFs\nlicense: MIT\n---\nDo this.\n");
    const { skills, problems } = await loadSkills([{ name: "t", dir: root }]);
    expect(problems).toEqual([]);
    expect(skills).toEqual([
      { name: "pdf-forms", description: "Fill PDFs", instructions: "Do this.", dir: path.join(root, "pdf") },
    ]);
  });

  it("treats a missing folder as no skills", async () => {
    const root = await tmp();
    expect(await loadSkills([{ name: "t", dir: path.join(root, "nope") }])).toEqual({ skills: [], problems: [] });
  });

  it("skips a skill with no header, name or description, with a plain message", async () => {
    const root = await tmp();
    await skill(root, "a", "Just text");
    await skill(root, "b", "---\ndescription: x\n---\nBody");
    await skill(root, "c", "---\nname: c\n---\nBody");
    await mkdir(path.join(root, "empty"));
    const { skills, problems } = await loadSkills([{ name: "t", dir: root }]);
    expect(skills).toEqual([]);
    expect(problems.map((p) => p.file)).toEqual([path.join("a", "SKILL.md"), path.join("b", "SKILL.md"), path.join("c", "SKILL.md")]);
    expect(problems[0].message).toContain("no header");
    expect(problems[1].message).toContain("no name");
    expect(problems[2].message).toContain("no description");
  });

  it("skips a duplicate name, the first source winning", async () => {
    const one = await tmp();
    const two = await tmp();
    await skill(one, "x", "---\nname: Same\ndescription: first\n---\nOne");
    await skill(two, "y", "---\nname: same\ndescription: second\n---\nTwo");
    const { skills, problems } = await loadSkills([
      { name: "one", dir: one },
      { name: "two", dir: two },
    ]);
    expect(skills.map((s) => s.description)).toEqual(["first"]);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("already has");
  });
});

describe("skillSources", () => {
  it("uses the env var when set, else the user's skills folder", async () => {
    const before = process.env.LLAMA_MUI_SKILLS_DIR;
    try {
      process.env.LLAMA_MUI_SKILLS_DIR = "/tmp/somewhere";
      expect(skillSources().map((s) => s.dir)).toEqual(["/tmp/somewhere"]);
      delete process.env.LLAMA_MUI_SKILLS_DIR;
      expect(skillSources()[0].dir).toBe(path.join(os.homedir(), ".llama-mui", "skills"));
    } finally {
      if (before === undefined) delete process.env.LLAMA_MUI_SKILLS_DIR;
      else process.env.LLAMA_MUI_SKILLS_DIR = before;
    }
  });
});
