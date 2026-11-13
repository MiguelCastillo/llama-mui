// Vite plugin that serves the app's /api: settings, preferences and model
// options, the llama proxy, and the model's tools. It runs in both `vite` (dev) and
// `vite preview`.

import type { Server } from "node:http";
import type { Connect, Plugin } from "vite";
import { setApiOrigin } from "../src/api.ts";
import { commandRoutes } from "./commands.ts";
import { connectorRoutes } from "./connectors.ts";
import { attachmentRoutes } from "./disk.ts";
import { eventRoutes } from "./events.ts";
import { HttpError, type Route, sendJson } from "./http.ts";
import { imageRoutes } from "./images.ts";
import { personaRoutes } from "./personaRoutes.ts";
import { ruleRoutes } from "./rules.ts";
import { modelSettingRoutes } from "./models.ts";
import { isAllowed, isPairing, phoneRoutes, setListenAddress } from "./phones.ts";
import { preferenceRoutes } from "./preferences.ts";
import { usageRoutes } from "./usageRoutes.ts";
import { selfOrigin } from "./selfOrigin.ts";
import { sessionRoutes } from "./sessions.ts";
import { toolRoutes } from "./tools.ts";
import { modelAdminRoutes } from "./modelAdmin.ts";
import { recoverOnce } from "./restart.ts";
import { stopAllRuns } from "./runners.ts";

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
  if (await imageRoutes(r)) return;
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
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

export const handler: Connect.NextHandleFunction = (req, res) => {
  if (isCrossSite(req)) return sendJson(res, 403, { error: "Cross-site requests aren't allowed" });
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
      sendJson(res, 401, {
        error: "This device isn't paired. On the computer running llama-mui, open Settings → Phone and scan the code.",
        reason: "unpaired",
      });
    })
    .catch((e) => {
    if (res.headersSent) return void res.end();
    sendJson(res, e instanceof HttpError ? e.status : 500, { ...(e instanceof HttpError ? e.extra : {}), error: e.message });
  });
};

// What a server does when it starts. Plans run on the server call its own /api over http (see setApiOrigin), so
// once the server is listening it tells the client code where that is. Plain
// http only: a server started with https would need to trust its own certificate.
export function whenServing(httpServer: Server | null) {
  // A run that was going when the last server stopped is marked as interrupted
  // (see restart.ts); this server's own runs end if it is closed meanwhile.
  void recoverOnce();
  httpServer?.once("close", () => void stopAllRuns());
  if (!httpServer || "setSecureContext" in httpServer) return;
  const set = () => {
    const address = httpServer.address();
    setListenAddress(address);
    const origin = selfOrigin(address);
    if (origin) setApiOrigin(origin);
  };
  if (httpServer.listening) set();
  else httpServer.once("listening", set);
}

export function api(): Plugin {
  return {
    name: "llama-mui-api",
    configureServer(server) {
      server.middlewares.use("/api", handler);
      whenServing(server.httpServer as Server | null);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api", handler);
      whenServing(server.httpServer as Server | null);
    },
  };
}
