// Writes the server's own comings and goings to the log (log.ts): it started
// (and how), is listening where, was closed with which requests to model
// servers still open, and how the process ended if it did. Starts the watch of
// the model servers (watch.ts). Both the plain Node server (main.ts) and the
// Vite one (the `logging` plugin below) call logServing, so a restart of either
// leaves the same lines.

import type { Server } from "node:http";
import { createLogger, type Logger, type Plugin } from "vite";
import { startAuditPruning } from "./audit.ts";
import { log, logHint, logProcessEnd, pruneLogs } from "./log.ts";
import { openRequests } from "./upstreamLog.ts";
import { startWatching } from "./watch.ts";

export type Mode = "prod" | "dev" | "preview";

export function logServing(httpServer: Server | null, mode: Mode): void {
  logProcessEnd();
  pruneLogs();
  startAuditPruning();
  log("server.start", { mode, node: process.version, cwd: process.cwd() });
  if (httpServer) {
    const announce = () => {
      const a = httpServer.address();
      log("server.listening", a && typeof a === "object" ? { address: a.address, port: a.port } : { address: String(a) });
      console.log(logHint());
    };
    if (httpServer.listening) announce();
    else httpServer.once("listening", announce);
    // Closing the server (Vite does it to restart, a shutdown does it to stop)
    // cuts every reply that is still streaming: say which ones.
    httpServer.once("close", () => log("server.close", { open: openRequests() }));
  }
  startWatching();
}

const LOG_LINES = 5;
const LOG_CHARS = 600;

// A Vite message as plain text for the log: colors removed, only the first few
// lines (the rest is usually a code frame of the user's file), length capped.
export function plainViteMessage(msg: unknown): string {
  const text = String(msg ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const lines = text.split("\n").slice(0, LOG_LINES).join("\n");
  return lines.length > LOG_CHARS ? lines.slice(0, LOG_CHARS) + "…" : lines;
}

// Wraps a Vite logger so its warnings and errors also leave a line in the log
// (vite.warn, vite.error), then go to the original untouched: the terminal
// output does not change. Nothing here may break Vite's own logging.
export function withLogFile(inner: Logger): Logger {
  const note = (event: string, msg: unknown) => {
    try {
      log(event, { message: plainViteMessage(msg) });
    } catch {
      // Logging never breaks the server.
    }
  };
  return {
    info: (msg, o) => inner.info(msg, o),
    warn: (msg, o) => {
      note("vite.warn", msg);
      inner.warn(msg, o);
    },
    warnOnce: (msg, o) => {
      note("vite.warn", msg);
      inner.warnOnce(msg, o);
    },
    error: (msg, o) => {
      note("vite.error", msg);
      inner.error(msg, o);
    },
    clearScreen: (type) => inner.clearScreen(type),
    hasErrorLogged: (e) => inner.hasErrorLogged(e),
    get hasWarned() {
      return inner.hasWarned;
    },
  };
}

// For vite.config.ts: the same lines for the dev and preview servers, and
// Vite's own warnings and errors. A plugin's config hook runs before Vite makes
// its logger and Vite reads customLogger afterwards, so it can be set here.
export function logging(): Plugin {
  return {
    name: "llama-mui-log",
    config(c) {
      return { customLogger: withLogFile(createLogger(c.logLevel, { allowClearScreen: c.clearScreen })) };
    },
    configureServer(server) {
      logServing(server.httpServer as Server | null, "dev");
    },
    configurePreviewServer(server) {
      logServing(server.httpServer as Server | null, "preview");
    },
  };
}
