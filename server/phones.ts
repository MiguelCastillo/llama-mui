// Using llama-mui from a phone (or any other device on the network).
//
// The server has no login, and its tools run commands on this computer, so a
// device that isn't this computer has to be paired first. On the computer,
// Settings → Phone shows a QR code holding a one-time token; the phone opens
// it, trades the token for a cookie, and from then on its requests are let in.
// Requests from this computer itself need nothing, as before. A request counts
// as coming from this computer only if it arrived over the loopback address
// with no proxy header: a reverse proxy running here (Tailscale serve, say)
// connects from loopback too, but says who it's forwarding for.
//
// Only a hash of each device's cookie is saved, in ~/.llama-mui/devices.json,
// so that file alone lets nobody in. Pairing tokens live in memory and are
// good once, for a few minutes. Plain http on a shared network can be sniffed;
// docs/guide.md says what that means.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";

export const COOKIE = "llama_mui_device";
// A pairing code works for this long, once.
export const PAIRING_TTL_MS = 5 * 60 * 1000;
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const MAX_CODES = 10;
// Wrong codes in a row before pairing waits a minute.
const MAX_FAILURES = 10;
const LAST_SEEN_EVERY_MS = 10 * 60 * 1000;

interface Device {
  id: string;
  name: string;
  hash: string; // sha256 of the cookie's secret, hex
  pairedAt: number;
  lastSeen: number;
}

// Read at call time, not at load, so a test can point the home folder elsewhere.
const devicesFile = () => path.join(os.homedir(), ".llama-mui", "devices.json");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function readDevices(): Promise<Device[]> {
  try {
    const raw = JSON.parse(await readFile(devicesFile(), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function writeDevices(devices: Device[]): Promise<void> {
  const file = devicesFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  await writeFile(`${file}.tmp`, JSON.stringify(devices, null, 2) + "\n", { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

// Saves run one at a time: two pairings at once must both end up in the file.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---- who is asking ----------------------------------------------------

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLocal(req: IncomingMessage): boolean {
  if (req.headers["x-forwarded-for"] || req.headers["forwarded"] || req.headers["x-real-ip"]) return false;
  return LOOPBACK.has(req.socket?.remoteAddress ?? "");
}

function cookieValue(req: IncomingMessage): string | null {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The paired device this request's cookie belongs to, if any.
async function deviceOf(req: IncomingMessage): Promise<Device | null> {
  const secret = cookieValue(req);
  if (!secret) return null;
  const hash = sha256(secret);
  const device = (await readDevices()).find((d) => sameHash(d.hash, hash));
  if (device && Date.now() - device.lastSeen > LAST_SEEN_EVERY_MS) {
    await exclusive(async () => {
      const all = await readDevices();
      const d = all.find((x) => x.id === device.id);
      if (d) {
        d.lastSeen = Date.now();
        await writeDevices(all);
      }
    });
  }
  return device ?? null;
}

// Whether a request may use /api: this computer, a paired device, or a device
// that is pairing right now (see isPairing).
export async function isAllowed(req: IncomingMessage): Promise<boolean> {
  return isLocal(req) || (await deviceOf(req)) !== null;
}

// The one /api request an unpaired device may make.
export const isPairing = (parts: string[], method: string) => method === "POST" && parts.length === 1 && parts[0] === "pair";

// ---- pairing codes ----------------------------------------------------

// sha256 of the token → when it stops working.
const codes = new Map<string, number>();
let failures: number[] = [];

function newCode(now: number): { token: string; expiresAt: number } {
  for (const [h, t] of codes) if (t <= now) codes.delete(h);
  if (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value!);
  const token = randomBytes(24).toString("base64url");
  const expiresAt = now + PAIRING_TTL_MS;
  codes.set(sha256(token), expiresAt);
  return { token, expiresAt };
}

// True if the token was good; it is used up either way.
function useCode(token: string, now: number): boolean {
  failures = failures.filter((t) => now - t < 60_000);
  if (failures.length >= MAX_FAILURES) throw new HttpError(429, "Too many wrong codes. Wait a minute, then make a new code on your computer.");
  const hash = sha256(token);
  const expiresAt = codes.get(hash);
  codes.delete(hash);
  if (expiresAt === undefined || expiresAt <= now) {
    failures.push(now);
    return false;
  }
  return true;
}

// For tests.
export const _resetPairing = () => {
  codes.clear();
  failures = [];
};

// ---- the address the server listens on -------------------------------

let listening: AddressInfo | string | null = null;
export const setListenAddress = (a: AddressInfo | string | null) => void (listening = a);

// Whether other devices can reach the server at all: it is listening on every
// interface (npm run prod:lan), not just this computer's loopback.
export function reachable(): boolean {
  if (!listening || typeof listening === "string") return false;
  return !LOOPBACK.has(listening.address) && listening.address !== "localhost";
}

// This computer's addresses on its networks, to put in the QR code.
export function addresses(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

// What to call a device from its browser, for the list in Settings.
export function nameFor(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? "Android phone" : "Android tablet";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows PC";
  if (/Linux/i.test(userAgent)) return "Linux computer";
  return "Device";
}

// ---- routes -----------------------------------------------------------

const summary = ({ id, name, pairedAt, lastSeen }: Device) => ({ id, name, pairedAt, lastSeen });

// Handles /api/phone (this computer only) and POST /api/pair (anyone, with a
// good code); returns false for anything else.
//   GET    /phone               → { reachable, port, addresses: [{ name, address }], devices }
//   POST   /phone/pairing       → { token, expiresAt }; 409 unless reachable
//   DELETE /phone/devices/<id>  → { id }; that device is signed out
//   POST   /pair { token }      → sets the device cookie; { ok: true, name }
export async function phoneRoutes({ req, res, parts, method }: Route, now = Date.now()): Promise<boolean> {
  if (parts[0] === "pair") {
    if (!isPairing(parts, method)) return false;
    const body = await readJson(req);
    if (typeof body.token !== "string" || !useCode(body.token, now)) {
      throw new HttpError(403, "That code didn't work. It may have expired or been used already: make a new one on your computer.");
    }
    const secret = randomBytes(32).toString("base64url");
    const device: Device = {
      id: randomBytes(8).toString("hex"),
      name: nameFor(String(req.headers["user-agent"] ?? "")),
      hash: sha256(secret),
      pairedAt: now,
      lastSeen: now,
    };
    await exclusive(async () => writeDevices([...(await readDevices()), device]));
    res.setHeader("Set-Cookie", `${COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`);
    sendJson(res, 200, { ok: true, name: device.name });
    return true;
  }

  if (parts[0] !== "phone") return false;
  // Managing devices is for the person at this computer; a paired phone can't
  // pair more phones or sign others out.
  if (!isLocal(req)) throw new HttpError(403, "Pairing is set up on the computer running llama-mui");

  if (parts.length === 1 && method === "GET") {
    const port = typeof listening === "object" && listening ? listening.port : 0;
    sendJson(res, 200, { reachable: reachable(), port, addresses: addresses(), devices: (await readDevices()).map(summary) });
    return true;
  }
  if (parts.length === 2 && parts[1] === "pairing" && method === "POST") {
    if (!reachable()) {
      throw new HttpError(409, "llama-mui is only listening on this computer. Stop it and start it with `npm run prod:lan`, then try again.");
    }
    sendJson(res, 200, newCode(now));
    return true;
  }
  if (parts.length === 3 && parts[1] === "devices" && method === "DELETE") {
    const id = parts[2];
    const gone = await exclusive(async () => {
      const all = await readDevices();
      if (!all.some((d) => d.id === id)) return false;
      await writeDevices(all.filter((d) => d.id !== id));
      return true;
    });
    if (!gone) throw new HttpError(404, "No such device");
    sendJson(res, 200, { id });
    return true;
  }
  return false;
}
