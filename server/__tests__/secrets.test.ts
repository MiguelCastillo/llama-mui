import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests never touch the real ~/.llama-mui or ~/.config.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { KEYS_FILE, SECRET_KEY_FILE, openKeys, sealKeys } = await import("../secrets.ts");
const { SETTINGS_FILE, load, save } = await import("../store.ts");
const { isSettingsFile } = await import("../disk.ts");

const KEY = "sk-test-secret-0123456789";
const mode = async (f: string) => (await stat(f)).mode & 0o777;
const reset = () => Promise.all([KEYS_FILE, SECRET_KEY_FILE, SETTINGS_FILE].map((f) => rm(f, { force: true })));

describe("the encrypted keys", () => {
  it("seals keys without writing them in the clear, in private files, and opens them again", async () => {
    await reset();
    await sealKeys({ a: KEY, b: "other-key" });
    expect(await readFile(KEYS_FILE, "utf8")).not.toContain(KEY);
    expect(await mode(KEYS_FILE)).toBe(0o600);
    expect(await mode(SECRET_KEY_FILE)).toBe(0o600);
    expect((await openKeys()).keys).toEqual({ a: KEY, b: "other-key" });
  });

  it("keeps the unlocking key outside ~/.llama-mui", () => {
    expect(SECRET_KEY_FILE.startsWith(home.dir + "/.llama-mui/")).toBe(false);
  });

  it("won't open an entry that was changed or moved to another connector", async () => {
    await reset();
    await sealKeys({ a: KEY, b: "other-key" });
    const file = JSON.parse(await readFile(KEYS_FILE, "utf8"));
    // b's entry placed under a's id: authenticated against the wrong id.
    file.keys.a = file.keys.b;
    await writeFile(KEYS_FILE, JSON.stringify(file));
    const opened = await openKeys();
    expect(opened.locked).toEqual(["a"]);
    expect(opened.keys).toEqual({ b: "other-key" });
    // A flipped byte in the data fails too.
    file.keys.b.data = Buffer.from("tampered!tampered!").toString("base64");
    await writeFile(KEYS_FILE, JSON.stringify(file));
    expect((await openKeys()).locked).toContain("b");
  });

  it("refuses an unlocking key that other users can read, and says how to fix it", async () => {
    await reset();
    await sealKeys({ a: KEY });
    await chmod(SECRET_KEY_FILE, 0o644);
    await expect(openKeys()).rejects.toThrow(`chmod 600 ${SECRET_KEY_FILE}`);
    await chmod(SECRET_KEY_FILE, 0o600);
    expect((await openKeys()).keys.a).toBe(KEY);
  });

  it("reports entries as locked, and keeps them, when the unlocking key is missing", async () => {
    await reset();
    await sealKeys({ a: KEY });
    await rm(SECRET_KEY_FILE);
    expect(await openKeys()).toMatchObject({ keys: {}, locked: ["a"] });
    // A save that names a as locked leaves its entry alone.
    await sealKeys({}, ["a"]);
    expect(JSON.parse(await readFile(KEYS_FILE, "utf8")).keys.a).toBeDefined();
  });

  it("uses LLAMA_MUI_SECRET_KEY instead of a key file, and rejects one of the wrong size", async () => {
    await reset();
    const { randomBytes } = await import("node:crypto");
    vi.stubEnv("LLAMA_MUI_SECRET_KEY", randomBytes(32).toString("base64"));
    await sealKeys({ a: KEY });
    expect(await stat(SECRET_KEY_FILE).catch(() => null)).toBeNull();
    expect((await openKeys()).keys.a).toBe(KEY);
    vi.stubEnv("LLAMA_MUI_SECRET_KEY", "too-short");
    await expect(openKeys()).rejects.toThrow("32 bytes");
    vi.unstubAllEnvs();
  });

  it("is off limits to the file tools, like settings.json", () => {
    expect(isSettingsFile(KEYS_FILE)).toBe(true);
    expect(isSettingsFile(SECRET_KEY_FILE)).toBe(true);
    expect(isSettingsFile(SETTINGS_FILE)).toBe(true);
  });
});

describe("settings and keys", () => {
  const connector = { id: "c1", name: "Local", url: "http://localhost:8080", apiKey: KEY };

  it("moves keys out of an old settings.json, checks them, and then loads them back", async () => {
    await reset();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(SETTINGS_FILE.replace(/\/settings\.json$/, ""), { recursive: true });
    await writeFile(SETTINGS_FILE, JSON.stringify({ connectors: [connector] }));
    const store = await load();
    expect(store.connectors[0].apiKey).toBe(KEY);
    expect(await readFile(SETTINGS_FILE, "utf8")).not.toContain(KEY);
    expect(await readFile(KEYS_FILE, "utf8")).not.toContain(KEY);
    expect((await load()).connectors[0].apiKey).toBe(KEY);
  });

  it("saves a new key encrypted, and a cleared key removes it", async () => {
    await reset();
    const store = await load();
    store.connectors = [connector];
    await save(store);
    expect(await readFile(SETTINGS_FILE, "utf8")).not.toContain(KEY);
    expect((await load()).connectors[0].apiKey).toBe(KEY);
    const again = await load();
    again.connectors[0].apiKey = "";
    await save(again);
    expect((await load()).connectors[0].apiKey).toBe("");
    expect((await openKeys()).keys).toEqual({});
  });

  it("doesn't erase a key that was only locked when other settings are saved", async () => {
    await reset();
    const store = await load();
    store.connectors = [connector];
    await save(store);
    await rm(SECRET_KEY_FILE);
    const locked = await load();
    expect(locked.connectors[0].apiKey).toBe("");
    locked.preferences.showModelName = true;
    await save(locked);
    expect(JSON.parse(await readFile(KEYS_FILE, "utf8")).keys.c1).toBeDefined();
  });
});
