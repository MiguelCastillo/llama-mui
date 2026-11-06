// Writes the server's own comings and goings to the log (log.ts): it started
// (and how), is listening where, was closed with which requests to model
// servers still open, and how the process ended if it did. Starts the watch of
// the model servers (watch.ts). Both the plain Node server (main.ts) and the
// Vite one (the `logging` plugin below) call logServing, so a restart of either
// leaves the same lines.

import type { Server } from "node:http";
import type { Plugin } from "vite";
import { log, logProcessEnd, pruneLogs } from "./log.ts";
import { openRequests } from "./upstreamLog.ts";
import { startWatching } from "./watch.ts";

export type Mode = "prod" | "dev" | "preview";

export function logServing(httpServer: Server | null, mode: Mode): void {
  logProcessEnd();
  pruneLogs();
  log("server.start", { mode, node: process.version, cwd: process.cwd() });
  if (httpServer) {
    const announce = () => {
      const a = httpServer.address();
      log("server.listening", a && typeof a === "object" ? { address: a.address, port: a.port } : { address: String(a) });
    };
    if (httpServer.listening) announce();
    else httpServer.once("listening", announce);
    // Closing the server (Vite does it to restart, a shutdown does it to stop)
    // cuts every reply that is still streaming: say which ones.
    httpServer.once("close", () => log("server.close", { open: openRequests() }));
  }
  startWatching();
}

// For vite.config.ts: the same lines for the dev and preview servers.
export function logging(): Plugin {
  return {
    name: "llama-mui-log",
    configureServer(server) {
      logServing(server.httpServer as Server | null, "dev");
    },
    configurePreviewServer(server) {
      logServing(server.httpServer as Server | null, "preview");
    },
  };
}
