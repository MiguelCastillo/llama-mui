// Vite plugin that serves the app's /api: settings, preferences and model
// options, the llama proxy, and the model's tools. It runs in both `vite` (dev) and
// `vite preview`.

import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import type { Connect, Plugin } from "vite";
import { SESSION_HEADER, setApiOrigin, setSessionLabel } from "../src/api.ts";
import { prepareLoginEnv } from "./terminal.ts";
import { commandRoutes } from "./commands.ts";
import { connectorRoutes } from "./connectors.ts";
import { attachmentRoutes } from "./disk.ts";
import { eventRoutes } from "./events.ts";
import { HttpError, type Route, sendJson } from "./http.ts";
import { imageRoutes } from "./images.ts";
import { personaRoutes } from "./personaRoutes.ts";
import { skillRoutes } from "./skillRoutes.ts";
import { ruleRoutes } from "./rules.ts";
import { modelSettingRoutes } from "./models.ts";
import { guardNetwork, loadOtherDevices } from "./lan.ts";
import { isAllowed, isPairing, phoneRoutes, setListenAddress } from "./phones.ts";
import { preferenceRoutes } from "./preferences.ts";
import { usageRoutes } from "./usageRoutes.ts";
import { selfOrigin } from "./selfOrigin.ts";
import { sessionRoutes } from "./sessions.ts";
import { toolRoutes } from "./tools.ts";
import { modelAdminRoutes } from "./modelAdmin.ts";
import { log } from "./log.ts";
import { audit, noteSession, sessionExists, whoOf } from "./audit.ts";
import { currentCause, newId, runWithCause } from "./auditContext.ts";
import { recoverOnce } from "./restart.ts";
import { stopAllRuns } from "./runners.ts";
import { whisperRoutes } from "./whisper.ts";

async function route(r: Route) {
  if (await phoneRoutes(r)) return;
  if (await eventRoutes(r)) return;
  if (await connectorRoutes(r)) return;
  if (await modelAdminRoutes(r)) return;
  if (await toolRoutes(r)) return;
  if (await attachmentRoutes(r)) return;
  if (await preferenceRoutes(r)) return;
  if (await usageRoutes(r)) return;
  if (await modelSettingRoutes(r)) return;
  if (await commandRoutes(r)) return;
  if (await sessionRoutes(r)) return;
  if (await ruleRoutes(r)) return;
  if (await personaRoutes(r)) return;
  if (await skillRoutes(r)) return;
  if (await imageRoutes(r)) return;
  if (await whisperRoutes(r)) return;
  throw new HttpError(404, "Not found");
}

// Any page open in the browser can send requests to localhost, and a "simple"
// cross-site POST (text/plain, no preflight) reaches the handler even though
// the browser hides the response. Without this check, any website could run
// tools, and so commands, by sending its own approval. Browsers mark such
// requests with Sec-Fetch-Site and Origin; curl and other local programs send
// neither and are let through, since they can already act as the user.
function isCrossSite(req: Connect.IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    // Over https the dev server speaks HTTP/2, which has no Host header: the
    // address arrives as :authority instead.
    const host = req.headers.host ?? (req.headers[":authority"] as string | undefined);
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

// Why a request was refused, for the audit line: set where the refusal is
// made, read when the response closes.
type Why = { reason?: string };

// Every request that changes something (not GET) and every request that was
// refused or failed (status 400 and up) leaves one 'api.request' line. Plain
// reads that worked, such as the event streams and polling, are skipped.
// Only the method, the path (ids kept, no query), the status, the time taken,
// the reason and who sent it are written: never a body, header or cookie.
// A chat id as it is named in the audit log: letters, digits, dash, colon.
const SESSION_SHAPE = /^[A-Za-z0-9:-]{1,80}$/;

// The chat a request says it is made for, from the x-llama-session header (a
// run calling the server's own model proxy sets it, and so does the page for
// the chat it has open). From any caller it is used only when the id is well
// shaped and a chat with that id has a saved file. It is only a label for the
// audit log: it grants nothing, and the header itself is never written.
export function sessionFromHeader(req: Connect.IncomingMessage): string | undefined {
  const raw = req.headers[SESSION_HEADER];
  if (typeof raw !== "string" || !SESSION_SHAPE.test(raw)) return undefined;
  return sessionExists(raw) ? raw : undefined;
}

// What a run's calls to the server's own API name as their chat (see api.ts).
setSessionLabel(() => currentCause().session);

// How a request came in: the port of this server it reached, whether it was
// over https or plain http, and the HTTP version (an https request to Vite is
// HTTP/2, plain http is 1.1). A server listens on two ports, so the process id
// alone does not say which one a request used. Read when the request arrives,
// since a closed connection no longer knows its port.
export function connectionOf(req: Connect.IncomingMessage): { port?: number; scheme: "https" | "http"; http: string } {
  const socket = req.socket as (Connect.IncomingMessage["socket"] & { encrypted?: boolean }) | undefined;
  return {
    ...(typeof socket?.localPort === "number" ? { port: socket.localPort } : {}),
    scheme: socket?.encrypted ? "https" : "http",
    http: req.httpVersion === "2.0" ? "2" : req.httpVersion || "1.1",
  };
}

export const handler: Connect.NextHandleFunction = (req, res) => {
  const started = Date.now();
  const why: Why = {};
  const request = newId();
  const method = req.method ?? "GET";
  const named = sessionFromHeader(req);
  const via = connectionOf(req);
  res.once("close", () => {
    const status = res.statusCode;
    if (method === "GET" && status < 400) return;
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] === "sessions" && parts[1]) noteSession(parts[1]);
    audit("api.request", {
      request,
      method,
      route: "/api" + (pathname === "/" ? "" : pathname),
      ...(parts[0] === "sessions" && parts[1] ? { session: parts[1] } : named ? { session: named } : {}),
      status,
      ms: Date.now() - started,
      ...(why.reason ? { reason: why.reason } : {}),
      // A connection that closed before the answer was finished.
      ...(res.writableFinished ? {} : { aborted: true }),
      ...via,
      who: whoOf(req),
    });
  });
  // Whatever the request starts (tools, commands, fetches) carries its id.
  runWithCause({ request, who: whoOf(req), ...(named ? { session: named } : {}) }, () => serve(req, res, why));
};

function serve(req: Connect.IncomingMessage, res: Parameters<Connect.NextHandleFunction>[1], why: Why) {
  if (isCrossSite(req)) {
    why.reason = "cross-site";
    // Recorded so a refused request can be traced to what sent it. Only
    // address headers are kept, nothing from the body or cookies.
    log("api.cross-site-refused", {
      method: req.method,
      url: req.url,
      host: req.headers.host ?? req.headers[":authority"],
      origin: req.headers.origin,
      secFetchSite: req.headers["sec-fetch-site"],
      referer: req.headers.referer,
    });
    return sendJson(res, 403, { error: "Cross-site requests aren't allowed" });
  }
  // Mounted at /api, so req.url is relative to it.
  const url = new URL(req.url ?? "/", "http://x");
  const r: Route = {
    req,
    res,
    parts: url.pathname.split("/").filter(Boolean),
    method: req.method ?? "GET",
    search: url.search,
  };
  // This is the one gate for everything under /api: this computer, or a phone
  // that was paired (see phones.ts). Every route module is behind it.
  const allowed = isPairing(r.parts, r.method) ? Promise.resolve(true) : isAllowed(req);
  allowed
    .then((ok) => {
      if (ok) return route(r);
      why.reason = "unpaired";
      sendJson(res, 401, {
        error: "This device isn't paired. On the computer running llama-mui, open Settings → Phone and scan the code.",
        reason: "unpaired",
      });
    })
    .catch((e) => {
    why.reason = e.message;
    if (res.headersSent) return void res.end();
    sendJson(res, e instanceof HttpError ? e.status : 500, { ...(e instanceof HttpError ? e.extra : {}), error: e.message });
  });
}

// What a server does when it starts. Plans run on the server call its own /api over http (see setApiOrigin), so
// once the server is listening it tells the client code where that is.
//
// A server on https has a self-signed certificate (the browser needs https for
// the microphone), which Node's fetch would refuse and inspect_page can't click
// through. So it also gets a plain http listener on this computer's loopback
// only, serving the same app (`app`), on `httpPort` (0: any free port), and the
// server's own calls go there too. Loopback with no proxy header is what
// isAllowed lets in, so nothing else changes for them. A websocket upgrade
// (Vite's hot reload) is handed to the https server, which is the one that
// handles them. If `httpPort` is taken, the listener uses a free port instead
// and the log and console say so.
export function whenServing(httpServer: Server | null, app?: RequestListener, httpPort = 0) {
  // A run that was going when the last server stopped is marked as interrupted
  // (see restart.ts); this server's own runs end if it is closed meanwhile.
  void recoverOnce();
  httpServer?.once("close", () => void stopAllRuns());
  if (!httpServer) return;
  guardNetwork(httpServer);
  const secure = "setSecureContext" in httpServer;
  const set = () => {
    const address = httpServer.address();
    setListenAddress(address);
    if (!secure) {
      const origin = selfOrigin(address);
      if (origin) setApiOrigin(origin);
      return;
    }
    if (!app) return;
    const loopback = createHttpServer(app);
    loopback.requestTimeout = 0;
    loopback.on("upgrade", (req, socket, head) => httpServer.emit("upgrade", req, socket, head));
    const started = () => {
      const address = loopback.address();
      const origin = selfOrigin(address);
      if (origin) setApiOrigin(origin);
      if (httpPort && address && typeof address === "object") console.log(`llama-mui listening on http://127.0.0.1:${address.port} (this computer only)`);
    };
    loopback.once("error", (e: NodeJS.ErrnoException) => {
      log("server.http-error", { code: e.code, error: e.message, port: httpPort });
      console.error(`llama-mui: http on 127.0.0.1:${httpPort} didn't start (${e.code === "EADDRINUSE" ? "port in use; set HTTP_PORT" : e.message}); using another port`);
      loopback.listen(0, "127.0.0.1", started);
    });
    loopback.listen(httpPort, "127.0.0.1", started);
    httpServer.once("close", () => {
      setApiOrigin(null);
      loopback.close();
      loopback.closeAllConnections();
    });
  };
  if (httpServer.listening) set();
  else httpServer.once("listening", set);
}

// The Vite plugin: how `npm run dev` (configureServer) and `vite preview`
// (configurePreviewServer) serve /api. Those servers are Vite's own and never
// go through main.ts, which starts only `prod`, so what a server does at startup
// is repeated here.
//
// That includes prepareLoginEnv: run_command's environment is read as the
// server starts (see terminal.ts), so a slow or broken login profile shows up
// in the log at startup, not in the middle of a chat. main() calls it for
// `prod`; these two calls are the same for dev and preview. Without them a dev
// server would read it at the first command instead. It isn't in whenServing,
// which all three share, because tests start servers with createApp, which
// calls whenServing, and tests must never run the user's own login profile.
export function api(): Plugin {
  return {
    name: "llama-mui-api",
    configureServer(server) {
      server.middlewares.use("/api", handler);
      whenServing(server.httpServer as Server | null, server.middlewares as unknown as RequestListener, Number(process.env.HTTP_PORT ?? 5174));
      prepareLoginEnv();
      void loadOtherDevices();
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api", handler);
      whenServing(server.httpServer as Server | null, server.middlewares as unknown as RequestListener);
      prepareLoginEnv();
      void loadOtherDevices();
    },
  };
}
