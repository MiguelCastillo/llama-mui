import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const { createApp, resolveInside } = await import("../main.ts");

// A built client in a temp folder, with a file outside it that must never be served.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "llama-mui-dist-")));
const dist = path.join(root, "dist");
mkdirSync(path.join(dist, "assets"), { recursive: true });
writeFileSync(path.join(dist, "index.html"), "<html>the app</html>");
writeFileSync(path.join(dist, "assets", "app-abc123.js"), "console.log(1)");
writeFileSync(path.join(dist, "assets", "app-abc123.css"), "body{}");
writeFileSync(path.join(dist, "favicon.svg"), "<svg/>");
writeFileSync(path.join(root, "secret.txt"), "TOP SECRET");

// A raw request, so the path reaches the server as written (fetch would tidy "..").
function get(port: number, rawPath: string, opts: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: rawPath, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

describe("static files", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createApp(dist);
    port = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("serves the page with no-cache", async () => {
    const r = await get(port, "/");
    expect(r.status).toBe(200);
    expect(r.body).toBe("<html>the app</html>");
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-cache");
  });

  it("serves hashed assets as immutable, with the right type", async () => {
    const js = await get(port, "/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await get(port, "/assets/app-abc123.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await get(port, "/favicon.svg")).headers["content-type"]).toBe("image/svg+xml");
  });

  it("falls back to the page for a path that isn't a file, but 404s a missing asset", async () => {
    const r = await get(port, "/some/route?x=1");
    expect(r.status).toBe(200);
    expect(r.body).toBe("<html>the app</html>");
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect((await get(port, "/assets/gone-1.js")).status).toBe(404);
  });

  it("answers HEAD with headers and no body", async () => {
    const r = await get(port, "/assets/app-abc123.js", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.body).toBe("");
    expect(r.headers["content-length"]).toBe("14");
  });

  it("refuses other methods", async () => {
    expect((await get(port, "/", { method: "POST" })).status).toBe(405);
  });

  it("never serves anything outside dist", async () => {
    for (const p of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/assets/../../secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "//etc/passwd", "/%2fetc/passwd", "/..\\secret.txt", "/%5c..%5csecret.txt", "/a%00b", "/%zz"]) {
      const r = await get(port, p);
      expect(r.body, p).not.toContain("TOP SECRET");
      expect(r.body, p).not.toContain("root:");
      expect([200, 400, 404], p).toContain(r.status);
    }
    expect((await get(port, "/a%00b")).status).toBe(400);
  });

  it("resolves only to paths inside dist", () => {
    expect(resolveInside(dist, "/assets/app-abc123.js")).toBe(path.join(dist, "assets", "app-abc123.js"));
    expect(resolveInside(dist, "/%2e%2e/secret.txt")).toBe(path.join(dist, "secret.txt")); // clamped to dist
    expect(resolveInside(dist, "/a%00b")).toBeNull();
  });
});

describe("a missing build", () => {
  it("says to run the build", async () => {
    const server = createApp(path.join(root, "nope"));
    const port = await listen(server);
    try {
      const r = await get(port, "/");
      expect(r.status).toBe(503);
      expect(r.body).toContain("vite build");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("/api", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createApp(dist);
    port = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("reaches the handler with the /api prefix stripped (from this computer)", async () => {
    const r = await get(port, "/api/sessions");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toBeInstanceOf(Array);
    expect(r.headers["content-type"]).toBe("application/json");
    // An unknown route is the handler's own 404, not the page.
    const nope = await get(port, "/api/nothing-here");
    expect(nope.status).toBe(404);
    expect(JSON.parse(nope.body)).toEqual({ error: "Not found" });
  });

  it("is not the page: /apiary falls back to the app", async () => {
    expect((await get(port, "/apiary")).body).toBe("<html>the app</html>");
  });

  it("refuses a request that isn't from this computer and isn't paired", async () => {
    const r = await get(port, "/api/sessions", { headers: { "x-forwarded-for": "192.168.1.50" } });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).reason).toBe("unpaired");
  });

  it("refuses a cross-site request", async () => {
    const r = await get(port, "/api/sessions", { headers: { "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
  });
});
