import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { skillRoutes } from "../skillRoutes.ts";

// A folder of the test's own, so the real skills are never read.
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "llama-mui-skills-")));
process.env.LLAMA_MUI_SKILLS_DIR = dir;

const invoke = async (method: string, parts: string[]) => {
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  const handled = await skillRoutes({ req: {} as IncomingMessage, res, parts, method, search: "" } as any);
  return { handled, body: text ? JSON.parse(text) : {} };
};

describe("GET /api/skills", () => {
  it("lists skills by name and description only, with problems and the folder", async () => {
    mkdirSync(path.join(dir, "good"));
    writeFileSync(path.join(dir, "good", "SKILL.md"), "---\nname: good\ndescription: Does good\n---\nSecret body\n");
    mkdirSync(path.join(dir, "bad"));
    writeFileSync(path.join(dir, "bad", "SKILL.md"), "no header here");
    const r = await invoke("GET", ["skills"]);
    expect(r.handled).toBe(true);
    expect(r.body.skills).toEqual([{ name: "good", description: "Does good" }]);
    expect(JSON.stringify(r.body)).not.toContain("Secret body");
    expect(r.body.problems).toHaveLength(1);
    expect(r.body.folder).toBe(dir);
  });

  it("ignores other paths and methods", async () => {
    expect((await invoke("GET", ["personas"])).handled).toBe(false);
    expect((await invoke("POST", ["skills"])).handled).toBe(false);
  });
});
