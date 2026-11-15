// The production server: serves the built client from dist/ and the same /api as
// the Vite plugin (server/plugin.ts), in a plain Node process. Unlike `vite`, it
// isn't restarted when a source file changes, so replies streaming from a llama
// server (and runs) survive edits to llama-mui's own files. Run it with
// `npm run prod`; HTTPS_PORT and HTTP_PORT come from the environment. It
// listens twice: https on every interface, port HTTPS_PORT (default 5173; other
// devices are let in only when Settings → Phone allows it, see lan.ts;
// the certificate is generated at startup with selfsigned so no static cert
// files are needed; the microphone and phones need this one), and plain http
// on 127.0.0.1:HTTP_PORT (default 5172, this computer only), which
// inspect_page can open without a certificate warning.

import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createSecureServer, type Http2SecureServer, type Http2Session } from "node:http2";
import type { Duplex } from "node:stream";
import { selfSignedCert } from "./cert.ts";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOtherDevices } from "./lan.ts";
import { logServing } from "./lifecycle.ts";
import { log } from "./log.ts";
import { handler, whenServing } from "./plugin.ts";
import { stopAllRuns } from "./runners.ts";
import { prepareLoginEnv } from "./terminal.ts";
import { openRequests } from "./upstreamLog.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

const defaultDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

function plain(res: ServerResponse, status: number, text: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(text);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

// The file a request path names inside `dist`, or null if it names none (or
// tries to leave dist). The path is decoded first, so %2e%2e counts as "..".
export function resolveInside(dist: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const full = path.resolve(dist, "." + path.posix.normalize("/" + decoded));
  return full === dist || full.startsWith(dist + path.sep) ? full : null;
}

async function serveStatic(dist: string, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return plain(res, 405, "Method not allowed");
  }
  const index = path.join(dist, "index.html");
  if (!(await isFile(index))) {
    return plain(res, 503, "llama-mui hasn't been built yet. Run `npm run build` (or `npx vite build`), then start this server again.");
  }
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  const target = resolveInside(dist, pathname);
  if (target === null) return plain(res, 400, "Bad request");
  let file = target;
  if (target === dist || !(await isFile(target))) {
    // A missing hashed asset is a 404, not the page: answering with HTML would
    // make a stale tab fail with a confusing script error.
    if (pathname.startsWith("/assets/")) return plain(res, 404, "Not found");
    file = index;
  }
  const isIndex = file === index;
  const body = await readFile(file);
  res.statusCode = 200;
  res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Cache-Control", isIndex ? "no-cache" : pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  res.end(req.method === "HEAD" ? undefined : body);
}

// What answers requests: /api, then the built client in `dist`.
function makeApp(dist: string): RequestListener {
  const root = path.resolve(dist);
  return (req, res) => {
    const url = req.url ?? "/";
    if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) {
      // Mounted at /api the way connect does it, so the handler sees the path under it.
      req.url = url.slice("/api".length) || "/";
      if (!req.url.startsWith("/")) req.url = "/" + req.url;
      return void handler(req, res, () => plain(res, 404, "Not found"));
    }
    serveStatic(root, req, res).catch((e) => {
      if (res.headersSent) return void res.end();
      plain(res, 500, `Couldn't serve that: ${e?.message ?? e}`);
    });
  };
}

// HTTP/2 requests and replies are typed apart from IncomingMessage and
// ServerResponse, but have the parts the listener uses (url, method, headers,
// setHeader, end, ...).
type Http2Listener = Parameters<typeof createSecureServer>[1] & {};

// The https server speaks HTTP/2, and HTTP/1.1 to clients that don't.
export type AppServer = Server | Http2SecureServer;

// The timeouts an HTTP/1 connection reads from its server. An HTTP/2 server
// doesn't declare them, but its HTTP/1.1 fallback reads them off it all the same.
type Http1Limits = { requestTimeout: number; headersTimeout: number; keepAliveTimeout: number };

function limits(server: AppServer) {
  // Replies stream for minutes: no cap on a request, and a keep-alive that
  // outlives the gap between a page's requests.
  const s = server as unknown as Http1Limits;
  s.requestTimeout = 0;
  s.headersTimeout = 60_000;
  s.keepAliveTimeout = 65_000;
}

// The server, not yet listening. `dist` is where the built client is.
export function createApp(dist: string = defaultDist, options: { https?: boolean; httpPort?: number } = {}): AppServer {
  const app = makeApp(dist);
  const server: AppServer = options.https ? createSecureServer({ ...selfSignedCert(), allowHTTP1: true }, app as unknown as Http2Listener) : createServer(app);
  limits(server);
  // whenServing and logServing take a plain http Server (Vite's own HTTP/2 server
  // goes through them the same way); they use only what both kinds share.
  whenServing(server as Server, app, options.httpPort);
  return server;
}

// Http2 servers have no closeIdleConnections / closeAllConnections: their
// sessions are tracked here so a shutdown can end them too.
function trackConnections(server: AppServer) {
  const sessions = new Set<Http2Session>();
  const sockets = new Set<Duplex>();
  if (!("closeAllConnections" in server)) {
    server.on("session", (s) => {
      sessions.add(s);
      s.once("close", () => sessions.delete(s));
    });
    server.on("secureConnection", (s) => {
      sockets.add(s);
      s.once("close", () => sockets.delete(s));
    });
  }
  return {
    // Stops taking new requests on each HTTP/2 session; open ones finish.
    closeIdle() {
      if ("closeIdleConnections" in server) server.closeIdleConnections();
      for (const s of sessions) s.close();
    },
    closeAll() {
      if ("closeAllConnections" in server) server.closeAllConnections();
      for (const s of sessions) s.destroy();
      for (const s of sockets) s.destroy();
    },
  };
}

const GRACE_MS = 5_000;

function main() {
  // Read now, so a slow or broken login profile shows up at startup (see terminal.ts).
  prepareLoginEnv();
  void loadOtherDevices();
  const host = "0.0.0.0";
  const httpsPort = Number(process.env.HTTPS_PORT ?? 5173);
  const httpPort = Number(process.env.HTTP_PORT ?? 5172);
  const server = createApp(undefined, { https: true, httpPort });
  logServing(server as Server, "prod");
  const connections = trackConnections(server);

  let open = 0;
  server.on("request", (_req, res) => {
    open++;
    res.once("close", () => open--);
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    log("server.error", { code: e.code, error: e.message, host, port: httpsPort });
    console.error(e.code === "EADDRINUSE" ? `llama-mui: ${host}:${httpsPort} is already in use. Set HTTPS_PORT to another port.` : `llama-mui: ${e.message}`);
    process.exit(1);
  });

  server.listen(httpsPort, host, () => {
    const a = server.address();
    const where = a && typeof a === "object" ? `${a.address}:${a.port}` : `${host}:${httpsPort}`;
    console.log(`llama-mui listening on https://${where} (pid ${process.pid})`);
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      log("server.shutdown", { signal, again: true, upstream: openRequests() });
      console.log(`llama-mui: ${signal} again, exiting now`);
      process.exit(1);
    }
    closing = true;
    log("server.shutdown", { signal, open, upstream: openRequests(), graceMs: GRACE_MS });
    console.log(`llama-mui shutting down (${signal}): ${open} request${open === 1 ? "" : "s"} still open, ${GRACE_MS / 1000}s to finish`);
    const finish = async () => {
      await stopAllRuns().catch(() => {});
      process.exit(0);
    };
    server.close(() => void finish());
    connections.closeIdle();
    setTimeout(() => {
      log("server.force-close", { open, upstream: openRequests() });
      connections.closeAll();
      setTimeout(() => void finish(), 1_000).unref();
    }, GRACE_MS).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) main();
