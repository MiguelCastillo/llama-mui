// The restart manager's only door: POST /restart and GET /status, on this computer only.
// It never forwards page or API traffic. Replies are plain JSON and never carry the
// app's environment, arguments or output.
//
// Kept small: node builtins and the log only, no app code.

import http from "node:http";
import type { RestartResult, Status } from "./supervisor.ts";
import { log } from "../log.ts";

// What this surface needs from the supervisor (a test's fake fits too).
export interface Restartable {
  status(): Status;
  restart(opts: { build: boolean }): Promise<RestartResult>;
}

export const RESTART_DELAY_MS = 2000;

const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"];

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("127.") || addr === "::ffff:127.0.0.1";
}

export function createManagerServer(supervisor: Restartable, delayMs = RESTART_DELAY_MS): http.Server {
  // True from the moment a restart is accepted until it has finished.
  let pending = false;

  const send = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  return http.createServer((req, res) => {
    const proxied = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
    if (!isLoopbackAddress(req.socket.remoteAddress) || proxied) {
      return send(res, 403, { error: "The restart manager only answers calls made directly from this computer." });
    }
    const path = (req.url ?? "").split("?")[0];
    if (path === "/status") {
      if (req.method !== "GET") return send(res, 405, { error: "Use GET." }, { allow: "GET" });
      return send(res, 200, supervisor.status());
    }
    if (path === "/restart") {
      if (req.method !== "POST") return send(res, 405, { error: "Use POST." }, { allow: "POST" });
      if (pending || supervisor.status().state === "restarting") {
        return send(res, 409, { error: "already restarting" });
      }
      pending = true;
      send(res, 202, { restarting: true, inSeconds: delayMs / 1000 });
      log("manager.restart-requested", {});
      setTimeout(() => {
        supervisor
          .restart({ build: true })
          .then((r) => {
            if (!r.ok) log("manager.restart-refused", { reason: r.reason });
          })
          .catch((e) => log("manager.restart-error", { error: String(e?.message ?? e).split("\n")[0].slice(0, 200) }))
          .finally(() => {
            pending = false;
          });
      }, delayMs);
      return;
    }
    send(res, 404, { error: "Not found. This server has POST /restart and GET /status." });
  });
}
