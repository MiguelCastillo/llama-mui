import { connect as http2Connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests never touch the real ~/.llama-mui.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const { createApp } = await import("../main.ts");
type AppServer = import("../main.ts").AppServer;

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "llama-mui-dist-")));
const dist = path.join(root, "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(path.join(dist, "index.html"), "<html>the app</html>");

type Reply = { status: number; body: string; version: string };

// An HTTP/2 request. Node's client sends :authority and no Host header.
function viaHttp2(port: number, rawPath: string, headers: Record<string, string> = {}) {
  return new Promise<Reply>((resolve, reject) => {
    const session = http2Connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    session.on("error", reject);
    const req = session.request({ ":path": rawPath, ...headers });
    let status = 0;
    let body = "";
    req.on("response", (h) => (status = Number(h[":status"])));
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      session.close();
      resolve({ status, body, version: "2" });
    });
    req.on("error", reject);
    req.end();
  });
}

// An HTTP/1.1 request to the same https port, as an older client or curl does.
function viaHttp1(port: number, rawPath: string, headers: Record<string, string> = {}) {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port, path: rawPath, rejectUnauthorized: false, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, version: res.httpVersion }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("https speaks HTTP/2 and HTTP/1.1", () => {
  let server: AppServer;
  let port: number;
  beforeAll(async () => {
    server = createApp(dist, { https: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => {
      server.close(() => r());
      (server as any).closeAllConnections?.();
    });
  });

  it("gives an HTTP/2 client the page and an /api reply", async () => {
    const page = await viaHttp2(port, "/");
    expect(page.status).toBe(200);
    expect(page.body).toBe("<html>the app</html>");
    const api = await viaHttp2(port, "/api/sessions");
    expect(api.status).toBe(200);
    expect(JSON.parse(api.body)).toBeInstanceOf(Array);
  });

  it("gives an HTTP/1.1 client the page and an /api reply", async () => {
    const page = await viaHttp1(port, "/");
    expect(page.version).toBe("1.1");
    expect(page.status).toBe(200);
    expect(page.body).toBe("<html>the app</html>");
    const api = await viaHttp1(port, "/api/sessions");
    expect(api.status).toBe(200);
    expect(JSON.parse(api.body)).toBeInstanceOf(Array);
  });

  it("accepts an HTTP/2 request whose origin matches :authority (no Host header)", async () => {
    const r = await viaHttp2(port, "/api/sessions", { origin: `https://127.0.0.1:${port}` });
    expect(r.status).toBe(200);
  });

  it("refuses an HTTP/2 request from a different origin", async () => {
    const r = await viaHttp2(port, "/api/sessions", { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });
});
