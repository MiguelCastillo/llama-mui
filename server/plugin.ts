// Vite plugin that serves the app's /api: settings, preferences and model
// options, the llama proxy, and the model's tools. It runs in both `vite` (dev) and
// `vite preview`.

import type { Connect, Plugin } from "vite";
import { connectorRoutes } from "./connectors.ts";
import { directoryRoutes } from "./disk.ts";
import { HttpError, type Route, sendJson } from "./http.ts";
import { modelSettingRoutes } from "./models.ts";
import { preferenceRoutes } from "./preferences.ts";
import { toolRoutes } from "./tools.ts";

async function route(r: Route) {
  if (await connectorRoutes(r)) return;
  if (await toolRoutes(r)) return;
  if (await directoryRoutes(r)) return;
  if (await preferenceRoutes(r)) return;
  if (await modelSettingRoutes(r)) return;
  throw new HttpError(404, "Not found");
}

const handler: Connect.NextHandleFunction = (req, res) => {
  // Mounted at /api, so req.url is relative to it.
  const url = new URL(req.url ?? "/", "http://x");
  const r: Route = {
    req,
    res,
    parts: url.pathname.split("/").filter(Boolean),
    method: req.method ?? "GET",
    search: url.search,
  };
  route(r).catch((e) => {
    if (res.headersSent) return void res.end();
    sendJson(res, e instanceof HttpError ? e.status : 500, { error: e.message });
  });
};

export function api(): Plugin {
  return {
    name: "llama-mui-api",
    configureServer: (server) => void server.middlewares.use("/api", handler),
    configurePreviewServer: (server) => void server.middlewares.use("/api", handler),
  };
}
