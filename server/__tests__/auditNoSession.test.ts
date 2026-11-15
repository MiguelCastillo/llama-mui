import { readFile, readdir } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Startup and background work has no chat behind it, so its audit lines must
// not get a session, even when a chat id is around.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { auditDir } = await import("../audit.ts");
const { readLoginEnv } = await import("../terminal.ts");
const { phoneRoutes } = await import("../phones.ts");
const { sessionRoutes } = await import("../sessions.ts");

const lines = async () => {
  const dir = auditDir();
  const files = (await readdir(dir).catch(() => [])).sort();
  const all = (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")))).join("");
  return all.split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const withWhy = async (why: string) => (await lines()).filter((l) => l.why === why);

describe("lines with no chat behind them", () => {
  it("terminal.login-env is written without a session", async () => {
    await readLoginEnv("/bin/sh", 10_000);
    const found = await vi.waitFor(async () => {
      const f = await withWhy("terminal.login-env");
      expect(f.length).toBeGreaterThan(0);
      return f;
    });
    expect(found.every((l) => l.session === undefined)).toBe(true);
  });

  it("phones.save, with no request around it, is written without a session", async () => {
    const file = path.join(home.dir, ".llama-mui", "devices.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([{ id: "d1", name: "Phone", hash: "x", pairedAt: 1, lastSeen: 1 }]));
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;
    const res = Object.assign(new PassThrough(), { statusCode: 200, setHeader() {} }) as any;
    expect(await phoneRoutes({ req, res, parts: ["phone", "devices", "d1"], method: "DELETE" } as any)).toBe(true);
    const found = await withWhy("phones.save");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((l) => l.session === undefined)).toBe(true);
  });

  it("sessions.migrate is written without a session", async () => {
    const old = path.join(home.dir, ".llama-mui", "chats");
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, "old-1.json"), JSON.stringify({ id: "old-1", title: "Old", messages: [] }));
    const req = { method: "GET", url: "/sessions", headers: { "x-llama-session": "old-1" }, socket: { remoteAddress: "127.0.0.1" } } as any;
    const res = Object.assign(new PassThrough(), { statusCode: 200, setHeader() {} }) as any;
    res.on("data", () => {});
    await sessionRoutes({ req, res, parts: ["sessions"], method: "GET" } as any);
    const found = await withWhy("sessions.migrate");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((l) => l.session === undefined)).toBe(true);
  });
});
