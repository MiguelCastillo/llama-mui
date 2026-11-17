import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Pins the exact full system prompt of a chat on Builder (personas/Builder.md). The
// snapshot files live in __snapshots__ and are meant to be read: when the
// wording changes on purpose, review the diff and update them (vitest -u).
//
// Change log:
// - Builder's last line ("For a task that changes files, first call
//   update_plan...") became the size rule as two levels, Light and Standard.
//   Only the tools-on snapshots change; the tools-off ones have no persona text.

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { toolRoutes } = await import("../tools.ts");
const { load, save } = await import("../store.ts");

const rulesFile = () => path.join(home.dir, ".llama-mui", "rules.md");

const setRules = async (text: string | null) => {
  if (text === null) return rm(rulesFile(), { force: true });
  await mkdir(path.dirname(rulesFile()), { recursive: true });
  await writeFile(rulesFile(), text);
};

const ask = async (extra: Record<string, unknown> = {}) => {
  const body = { attachments: [], promptDir: "/work", ...extra };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "context"], method: "POST", search: "" });
  return JSON.parse(text);
};

const prompt = async (extra: Record<string, unknown> = {}) =>
  // The home folder differs per run; everything else is the real text.
  ((await ask(extra)).systemPrompt as string).split(home.dir).join("<HOME>") + "\n";

const withToolsOff = async (run: () => Promise<void>) => {
  const store = await load();
  await save({ ...store, toolsEnabled: false });
  try {
    await run();
  } finally {
    await save(store);
  }
};

const snap = (name: string) => `__snapshots__/prompt-${name}.txt`;

describe("the full system prompt, as a snapshot", () => {
  it("tools on, no user rules", async () => {
    await setRules(null);
    await expect(await prompt()).toMatchFileSnapshot(snap("tools-on-no-rules"));
  });

  it("tools on, with user rules", async () => {
    await setRules("Be brief.");
    await expect(await prompt()).toMatchFileSnapshot(snap("tools-on-rules"));
  });

  it("tools off, no user rules", async () => {
    await setRules(null);
    await withToolsOff(async () => {
      await expect(await prompt()).toMatchFileSnapshot(snap("tools-off-no-rules"));
    });
  });

  it("tools off, with user rules", async () => {
    await setRules("Be brief.");
    await withToolsOff(async () => {
      await expect(await prompt()).toMatchFileSnapshot(snap("tools-off-rules"));
    });
  });
});

describe("the project's instructions in the prompt", () => {
  const LABEL = "Project instructions from AGENTS.md in the working directory.";
  const makeProject = async (text: string | null) => {
    const dir = path.join(home.dir, "project");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    if (text !== null) await writeFile(path.join(dir, "AGENTS.md"), text);
    return dir;
  };
  const count = (s: string, part: string) => s.split(part).length - 1;

  it("appears once, labelled, after the skills and before the working directory line", async () => {
    await setRules(null);
    const dir = await makeProject("PRINCIPLE-ONE: keep it simple.");
    const p = await prompt({ promptDir: dir });
    expect(count(p, "PRINCIPLE-ONE")).toBe(1);
    expect(count(p, LABEL)).toBe(1);
    const at = p.indexOf(LABEL);
    expect(at).toBeGreaterThan(p.indexOf("The user's home folder is"));
    expect(at).toBeLessThan(p.indexOf("Working directory:"));
    expect(p.indexOf("PRINCIPLE-ONE")).toBeLessThan(p.indexOf("Working directory:"));
    expect(p).toContain("not the user's preferences; follow them");
  });

  it("a long file is in the prompt in full; the recommendation is in the update only", async () => {
    await setRules(null);
    const long = `${"x".repeat(25_000)}\nLAST-LINE`;
    const dir = await makeProject(long);
    const r = await ask({ promptDir: dir });
    expect(r.systemPrompt).toContain(long);
    expect(count(r.systemPrompt, "LAST-LINE")).toBe(1);
    expect(r.systemPrompt).not.toContain("recommended");
    expect(r.update).toContain("Project instructions loaded: AGENTS.md");
    expect(r.update).toContain("Project instructions are long (25,010 characters); keeping AGENTS.md under 20,000 is recommended.");
  });

  it("a short file has no recommendation line", async () => {
    await setRules(null);
    const dir = await makeProject("short");
    const r = await ask({ promptDir: dir });
    expect(r.update).toContain("Project instructions loaded: AGENTS.md");
    expect(r.update).not.toContain("are long");
  });

  it("without a file the prompt is exactly what it was", async () => {
    await setRules(null);
    const dir = await makeProject(null);
    const withDir = await prompt({ promptDir: dir });
    const plain = await prompt({ promptDir: "/work" });
    expect(withDir).not.toContain("Project instructions from");
    expect(withDir.split("<HOME>/project").join("/work")).toBe(plain);
  });

  it("a frozen text sent back is used even if the file has changed", async () => {
    await setRules(null);
    const dir = await makeProject("OLD-TEXT");
    const first = await ask({ promptDir: dir });
    expect(first.projectInstructions).toMatchObject({ file: "AGENTS.md", text: "OLD-TEXT" });
    await writeFile(path.join(dir, "AGENTS.md"), "NEW-TEXT");
    const again = await ask({ promptDir: dir, projectInstructions: first.projectInstructions });
    expect(again.systemPrompt).toContain("OLD-TEXT");
    expect(again.systemPrompt).not.toContain("NEW-TEXT");
    expect(again.systemPrompt).toBe(first.systemPrompt);
    // "Fixed: none" stays none even though the file exists now.
    const none = await ask({ promptDir: dir, projectInstructions: null });
    expect(none.systemPrompt).not.toContain("Project instructions from");
  });

  it("is carried with tools off too", async () => {
    await setRules(null);
    const dir = await makeProject("PRINCIPLE-ONE: keep it simple.");
    await withToolsOff(async () => {
      const p = await prompt({ promptDir: dir });
      expect(count(p, "PRINCIPLE-ONE")).toBe(1);
      expect(count(p, LABEL)).toBe(1);
      expect(p).not.toContain("Working directory:");
    });
  });
});
