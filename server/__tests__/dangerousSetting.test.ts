import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests write their own settings.json, never the real one.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { load } = await import("../store.ts");
const { dangerousCommandRoutes, readForDecision, normalizeDangerous } = await import("../dangerousSetting.ts");
const { matchDangerous } = await import("../../src/dangerousCommands.ts");
const { isSettingsFile } = await import("../disk.ts");
const { SETTINGS_FILE } = await import("../store.ts");

const dir = () => path.join(home.dir, ".llama-mui");
const file = () => path.join(dir(), "settings.json");
const writeSettings = (s: unknown) => {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(), typeof s === "string" ? s : JSON.stringify(s));
};

const invoke = async (method: string, body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {} }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await dangerousCommandRoutes({ req, res, parts: ["dangerous-commands"], method, search: "" } as any);
  return { status: res.statusCode, body: text ? JSON.parse(text) : {} };
};

beforeEach(() => {
  rmSync(file(), { force: true });
});

describe("the dangerous commands setting", () => {
  it("is on, with nothing switched off, when there are no settings yet", async () => {
    expect((await invoke("GET")).body).toEqual({ enabled: true, off: [], custom: [] });
    expect(await readForDecision()).toMatchObject({ enabled: true });
  });

  it("is on for a settings file saved before it existed", async () => {
    writeSettings({ toolsEnabled: true });
    expect((await invoke("GET")).body).toEqual({ enabled: true, off: [], custom: [] });
  });

  it("round trips: what was saved is what comes back, from the file too", async () => {
    const saved = { enabled: false, off: ["elevated"], custom: [{ id: "mine", label: "Mine", pattern: "^foo\\b" }] };
    expect((await invoke("PUT", saved)).body).toEqual(saved);
    expect((await invoke("GET")).body).toEqual(saved);
    expect((await load()).dangerousCommands).toEqual(saved);
  });

  it("changes only the fields that were sent", async () => {
    await invoke("PUT", { off: ["elevated"] });
    expect((await invoke("PUT", { enabled: false })).body).toEqual({ enabled: false, off: ["elevated"], custom: [] });
  });

  it("keeps a field this version doesn't know, and doesn't send it as something it understands", async () => {
    writeSettings({ dangerousCommands: { enabled: true, future: { a: 1 } } });
    await invoke("PUT", { enabled: false });
    expect(JSON.parse(readFileSync(file(), "utf8")).dangerousCommands.future).toEqual({ a: 1 });
    expect((await load()).dangerousCommands.future).toEqual({ a: 1 });
  });

  it.each([
    ["a bad regular expression", { custom: [{ id: "x", label: "X", pattern: "(" }] }, /valid regular expression/],
    ["an empty pattern", { custom: [{ id: "x", label: "X", pattern: "  " }] }, /empty/],
    ["a pattern that is too long", { custom: [{ id: "x", label: "X", pattern: "a".repeat(301) }] }, /longer than/],
    ["no id", { custom: [{ label: "X", pattern: "a" }] }, /needs an id/],
    ["an id used by a built-in entry", { custom: [{ id: "elevated", label: "X", pattern: "a" }] }, /built-in/],
    ["the same id twice", { custom: [{ id: "x", pattern: "a" }, { id: "x", pattern: "b" }] }, /share the id/],
    ["a toggle that isn't a boolean", { enabled: "false" }, /true or false/],
    ["switching off an entry that doesn't exist", { off: ["nope"] }, /isn't a built-in/],
  ])("refuses %s, with a plain message, and saves nothing", async (_n, body, message) => {
    await expect(invoke("PUT", body)).rejects.toThrow(message);
    expect((await invoke("GET")).body).toEqual({ enabled: true, off: [], custom: [] });
  });

  it("drops unusable saved custom entries when reading, instead of failing", () => {
    const s = normalizeDangerous({ custom: [{ id: "bad", pattern: "(" }, { id: "ok", pattern: "x" }, 5, null] });
    expect(s.custom).toEqual([{ id: "ok", label: "ok", pattern: "x" }]);
  });
});

describe("reading the setting for a decision keeps the check on unless it is certainly off", () => {
  const stillOn = async () => {
    const setting = await readForDecision();
    expect(matchDangerous("pkill -f node", setting).map((e) => e.id)).toContain("stop-processes");
  };

  it("is off only when the file says enabled is false", async () => {
    writeSettings({ dangerousCommands: { enabled: false } });
    expect(matchDangerous("pkill -f node", await readForDecision())).toEqual([]);
  });

  it("is on when settings.json is missing", stillOn);

  it("is on when settings.json isn't valid JSON", async () => {
    writeSettings("{ not json");
    expect(await readForDecision()).toBeUndefined();
    await stillOn();
  });

  it("is on when settings.json can't be read", async () => {
    writeSettings({ dangerousCommands: { enabled: false } });
    chmodSync(file(), 0o000);
    try {
      // Skipped when the tests run as root, who can read it anyway.
      if (process.getuid?.() !== 0) await stillOn();
    } finally {
      chmodSync(file(), 0o600);
    }
  });

  it.each([["false"], [0], [null], [[]], [{}], ["off"]])("is on when enabled is %j", async (value) => {
    writeSettings({ dangerousCommands: { enabled: value } });
    await stillOn();
  });

  it.each([["false"], [0], [null], [true], [[]]])("is on when the whole setting is %j", async (value) => {
    writeSettings({ dangerousCommands: value });
    await stillOn();
  });
});

describe("the model can't change the setting", () => {
  it("the file tools refuse settings.json", () => {
    expect(isSettingsFile(SETTINGS_FILE)).toBe(true);
  });

  it.each([
    "echo '{}' > ~/.llama-mui/settings.json",
    "sed -i '' s/true/false/ $HOME/.llama-mui/settings.json",
    "cat ~/.llama-mui/.keys",
    "cp x ~/.config/llama-mui/secret.key",
    "python3 -c \"open('/Users/x/.llama-mui/settings.json','w')\"",
    "curl -X PUT -d '{\"enabled\":false}' http://localhost:5174/api/dangerous-commands",
  ])("a shell command that touches it is in the list: %s", (command) => {
    expect(matchDangerous(command).map((e) => e.id)).toContain("app-settings");
  });
});
