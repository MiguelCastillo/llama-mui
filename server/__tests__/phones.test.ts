import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const phones = await import("../phones.ts");
const { COOKIE, PAIRING_TTL_MS, _resetPairing, isAllowed, isLocal, nameFor, phoneRoutes, setListenAddress } = phones;

const LAN = "192.168.1.50";
const request = (parts: string[], method: string, opts: { from?: string; cookie?: string; body?: unknown; headers?: object } = {}) => {
  const req = Object.assign(Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]), {
    method,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", ...opts.headers },
    socket: { remoteAddress: opts.from ?? "127.0.0.1" },
  }) as unknown as IncomingMessage;
  const sent: { status: number; text: string; cookie?: string } = { status: 200, text: "" };
  const res = {
    statusCode: 200,
    setHeader: (n: string, v: string) => void (n === "Set-Cookie" && (sent.cookie = v)),
    end: (t: string) => {
      sent.status = res.statusCode;
      sent.text = t;
    },
  };
  return { req, res: res as unknown as ServerResponse, sent, parts, method };
};

const run = async (parts: string[], method: string, opts = {}, now?: number) => {
  const r = request(parts, method, opts);
  try {
    await phoneRoutes({ ...r, search: "" }, now);
  } catch (e: any) {
    return { status: e.status as number, body: { error: e.message }, cookie: undefined as string | undefined };
  }
  return { status: r.sent.status, body: r.sent.text ? JSON.parse(r.sent.text) : null, cookie: r.sent.cookie };
};

// Pairs a phone and returns the cookie it would send back.
async function pair(now = Date.now()) {
  const { body } = await run(["phone", "pairing"], "POST", {}, now);
  const done = await run(["pair"], "POST", { from: LAN, body: { token: body.token } }, now);
  expect(done.status).toBe(200);
  return done.cookie!.split(";")[0];
}

beforeEach(() => {
  _resetPairing();
  setListenAddress({ address: "::", family: "IPv6", port: 5173 });
});

describe("who counts as this computer", () => {
  it("is loopback with no proxy header", () => {
    expect(isLocal(request([], "GET").req)).toBe(true);
    expect(isLocal(request([], "GET", { from: "::1" }).req)).toBe(true);
    expect(isLocal(request([], "GET", { from: LAN }).req)).toBe(false);
    // A proxy on this computer connects from loopback but says who it forwards for.
    expect(isLocal(request([], "GET", { headers: { "x-forwarded-for": LAN } }).req)).toBe(false);
  });

  it("lets this computer in without a cookie, and other devices only with a paired one", async () => {
    expect(await isAllowed(request([], "GET").req)).toBe(true);
    expect(await isAllowed(request([], "GET", { from: LAN }).req)).toBe(false);
    const cookie = await pair();
    expect(await isAllowed(request([], "GET", { from: LAN, cookie }).req)).toBe(true);
    expect(await isAllowed(request([], "GET", { from: LAN, cookie: `${COOKIE}=guess` }).req)).toBe(false);
  });
});

describe("pairing", () => {
  it("gives a code once: it works one time and then not again", async () => {
    const { body } = await run(["phone", "pairing"], "POST");
    const first = await run(["pair"], "POST", { from: LAN, body: { token: body.token } });
    expect(first.status).toBe(200);
    expect(first.cookie).toMatch(new RegExp(`^${COOKIE}=[\\w-]{40,}; Path=/; HttpOnly; SameSite=Strict`));
    expect((await run(["pair"], "POST", { from: LAN, body: { token: body.token } })).status).toBe(403);
  });

  it("stops a code after five minutes", async () => {
    const t0 = Date.now();
    const { body } = await run(["phone", "pairing"], "POST", {}, t0);
    const late = await run(["pair"], "POST", { from: LAN, body: { token: body.token } }, t0 + PAIRING_TTL_MS + 1);
    expect(late.status).toBe(403);
    expect(late.body.error).toContain("make a new one");
  });

  it("refuses a wrong code, and waits after too many", async () => {
    for (let i = 0; i < 10; i++) expect((await run(["pair"], "POST", { from: LAN, body: { token: `nope${i}` } })).status).toBe(403);
    const { body } = await run(["phone", "pairing"], "POST");
    expect((await run(["pair"], "POST", { from: LAN, body: { token: body.token } })).status).toBe(429);
  });

  it("saves only a hash of the cookie, in a private file", async () => {
    const cookie = await pair();
    const file = path.join(home.dir, ".llama-mui", "devices.json");
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(cookie.split("=")[1]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("names the device from its browser", async () => {
    await pair();
    const { body } = await run(["phone"], "GET");
    expect(body.devices.at(-1).name).toBe("iPhone");
    expect(nameFor("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile")).toBe("Android phone");
  });

  it("only makes codes while the server is listening beyond this computer", async () => {
    setListenAddress({ address: "127.0.0.1", family: "IPv4", port: 5173 });
    const r = await run(["phone", "pairing"], "POST");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("npm run dev:lan");
  });
});

describe("managing devices", () => {
  it("is for this computer only", async () => {
    expect((await run(["phone"], "GET", { from: LAN })).status).toBe(403);
    expect((await run(["phone", "pairing"], "POST", { from: LAN })).status).toBe(403);
    const cookie = await pair();
    // Not even a paired phone.
    expect((await run(["phone"], "GET", { from: LAN, cookie })).status).toBe(403);
  });

  it("signs a device out when it's removed", async () => {
    const cookie = await pair();
    const { body } = await run(["phone"], "GET");
    const id = body.devices.at(-1).id;
    expect(await isAllowed(request([], "GET", { from: LAN, cookie }).req)).toBe(true);
    expect((await run(["phone", "devices", id], "DELETE")).status).toBe(200);
    expect(await isAllowed(request([], "GET", { from: LAN, cookie }).req)).toBe(false);
    expect((await run(["phone", "devices", id], "DELETE")).status).toBe(404);
  });
});
