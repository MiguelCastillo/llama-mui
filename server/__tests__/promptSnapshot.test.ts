import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Pins the exact full system prompt of a chat on Builder (personas/Builder.md). The
// snapshot files live in __snapshots__ and are meant to be read: when the
// wording changes on purpose, review the diff and update them (vitest -u).

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

const prompt = async () => {
  const req = Readable.from([Buffer.from(JSON.stringify({ attachments: [], promptDir: "/work" }))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "context"], method: "POST", search: "" });
  // The home folder differs per run; everything else is the real text.
  return (JSON.parse(text).systemPrompt as string).split(home.dir).join("<HOME>") + "\n";
};

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
