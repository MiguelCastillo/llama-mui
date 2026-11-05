// The connectors' API keys, encrypted. They used to sit in settings.json as
// plain text, so copying or backing up ~/.llama-mui copied them too. Now each
// key is sealed with AES-256-GCM into ~/.llama-mui/.keys, and the random key
// that unlocks them lives outside that folder (SECRET_KEY_FILE), so a copy of
// ~/.llama-mui alone holds nothing usable. It doesn't stop a program running
// as you that can read both places.
//
// The unlocking key is made at random the first time a key is saved. A server
// or container can supply it instead, in LLAMA_MUI_SECRET_KEY (32 bytes,
// base64). GCM also authenticates: an edited or damaged entry fails to open
// instead of giving back wrong text, and each entry is bound to its
// connector's id, so one can't be moved into another's place unnoticed.
// Lose the unlocking key and the keys are gone: Settings asks for them again.
//
// Laid out like ~/.ssh: the folder is 0700, the files 0600, and, as ssh does
// with a private key, an unlocking key that other users can read is refused
// with the command that fixes it, rather than quietly used.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const KEYS_FILE = path.join(os.homedir(), ".llama-mui", ".keys");

// Under the home folder on every platform, never in an environment variable's
// folder, so tests that point os.homedir elsewhere can't reach the real one.
const configDir =
  process.platform === "win32"
    ? path.join(os.homedir(), "AppData", "Roaming", "llama-mui")
    : path.join(os.homedir(), ".config", "llama-mui");
export const SECRET_KEY_FILE = path.join(configDir, "secret.key");

const ENV_KEY = "LLAMA_MUI_SECRET_KEY";

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}
interface KeysFile {
  v: 1;
  keys: Record<string, Sealed>;
}

function parseSecretKey(text: string, where: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new Error(`${where} must hold 32 bytes, base64 encoded.`);
  return key;
}

// Refuses a file that group or others can read or write, like ssh does for a
// private key. Windows has no such mode bits, so it can't be checked there.
async function requirePrivate(file: string): Promise<void> {
  if (process.platform === "win32") return;
  const mode = (await stat(file)).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `${file} can be read by other users (mode ${mode.toString(8)}), so it isn't used to unlock API keys. ` +
        `Fix it with: chmod 600 ${file}`,
    );
  }
}

// The unlocking key; made on first use when `create` is set, else null if there is none.
async function unlockingKey(create: boolean): Promise<Buffer | null> {
  if (process.env[ENV_KEY]) return parseSecretKey(process.env[ENV_KEY], ENV_KEY);
  try {
    await requirePrivate(SECRET_KEY_FILE);
    return parseSecretKey(await readFile(SECRET_KEY_FILE, "utf8"), SECRET_KEY_FILE);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!create) return null;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const fresh = randomBytes(32);
  try {
    // "wx": never overwrite a key another request just made.
    await writeFile(SECRET_KEY_FILE, fresh.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    return fresh;
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    await requirePrivate(SECRET_KEY_FILE);
    return parseSecretKey(await readFile(SECRET_KEY_FILE, "utf8"), SECRET_KEY_FILE);
  }
}

const seal = (key: Buffer, id: string, text: string): Sealed => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
};

const open = (key: Buffer, id: string, s: Sealed): string => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(s.data, "base64")), decipher.final()]).toString("utf8");
};

async function readKeysFile(): Promise<KeysFile> {
  try {
    const raw = JSON.parse(await readFile(KEYS_FILE, "utf8"));
    if (raw && typeof raw.keys === "object" && raw.keys) return { v: 1, keys: raw.keys };
  } catch (e: any) {
    if (e.code !== "ENOENT") console.warn(`Couldn't read ${KEYS_FILE}: ${e.message ?? e}`);
  }
  return { v: 1, keys: {} };
}

// The saved keys by connector id, and the ids of entries that wouldn't open
// (the unlocking key is missing or wrong, or the entry was changed). Those are
// reported, never dropped: see sealKeys.
export async function openKeys(): Promise<{ keys: Record<string, string>; locked: string[] }> {
  const file = await readKeysFile();
  const ids = Object.keys(file.keys);
  if (ids.length === 0) return { keys: {}, locked: [] };
  const key = await unlockingKey(false);
  const keys: Record<string, string> = {};
  const locked: string[] = [];
  for (const id of ids) {
    try {
      if (!key) throw new Error(`no unlocking key (${SECRET_KEY_FILE} or ${ENV_KEY})`);
      keys[id] = open(key, id, file.keys[id]);
    } catch (e: any) {
      locked.push(id);
      console.warn(`The API key for connector ${id} can't be opened (${e.message ?? e}). Enter it again in Settings → Connectors.`);
    }
  }
  return { keys, locked };
}

// Saves `keys` (connector id → key), replacing what was saved. An entry whose
// id is in `keep` and not in `keys` stays as it is: it couldn't be opened, so
// it mustn't be erased by a save. Anything else not in `keys` goes.
export async function sealKeys(keys: Record<string, string>, keep: string[] = []): Promise<void> {
  const old = await readKeysFile();
  const next: Record<string, Sealed> = {};
  for (const id of keep) if (!(id in keys) && old.keys[id]) next[id] = old.keys[id];
  const ids = Object.keys(keys).filter((id) => keys[id]);
  if (ids.length > 0) {
    const key = await unlockingKey(true);
    for (const id of ids) next[id] = seal(key!, id, keys[id]);
  }
  await mkdir(path.dirname(KEYS_FILE), { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  await writeFile(`${KEYS_FILE}.tmp`, JSON.stringify({ v: 1, keys: next } satisfies KeysFile, null, 2) + "\n", { mode: 0o600 });
  await rename(`${KEYS_FILE}.tmp`, KEYS_FILE);
}
