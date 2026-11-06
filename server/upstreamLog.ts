// What the log (log.ts) says about each request llama-mui forwards to a model
// server, from the proxies in connectors.ts and modelAdmin.ts. One `upstream.end`
// line per request says how it ended:
//
//   done              the reply arrived whole
//   client-closed     whoever asked hung up first: the Stop button, a closed tab,
//                     a run that was stopped, or this server shutting down
//   upstream-error    the model server's connection broke mid-reply (the error and
//                     its cause are in the line, and `idleMs` is how long it had been
//                     silent: a long gap before a break means it stalled first)
//   connect-failed    the model server couldn't be reached at all
//
// `via` is "browser" for a page and "server" for a call llama-mui made itself
// (plan runs and replies run here). Only what is safe to keep goes in: the
// connector's name, the path without its query, and numbers.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { errorFields, log } from "./log.ts";

interface Open {
  id: string;
  connector: string;
  method: string;
  path: string;
  startedAt: number;
}

const open = new Map<string, Open>();
let serial = 0;

// Requests to model servers that are going now, for the line a shutdown writes.
export const openRequests = () => [...open.values()].map((r) => ({ id: r.id, connector: r.connector, method: r.method, path: r.path, ageMs: Date.now() - r.startedAt }));

// A GET that went fine is not worth a line; one that was slow or failed is.
const SLOW_MS = 5_000;

export interface Tracked {
  // The model server answered with this status (headers only; the body follows).
  answered(status: number): void;
  // Counts what passes through: put it between the upstream body and the response.
  counter: Transform;
  // Watches the model server's body, to tell its connection breaking (the body
  // errors first) from whoever asked hanging up (the response closes first).
  watch(body: Readable): void;
  // The request never got an answer.
  failed(e: unknown): void;
  // The body has finished or broken: pass the error pipeline rejected with, if any.
  end(error?: unknown): void;
}

export function track(req: IncomingMessage, res: ServerResponse, connector: string, fullPath: string): Tracked {
  const id = `${Date.now().toString(36)}${(serial++ % 1296).toString(36).padStart(2, "0")}`;
  const path = fullPath.split("?")[0];
  const method = req.method ?? "GET";
  const startedAt = Date.now();
  const ua = String(req.headers["user-agent"] ?? "");
  const via = ua.startsWith("Mozilla") ? "browser" : "server";
  open.set(id, { id, connector, method, path, startedAt });
  if (method !== "GET" && method !== "HEAD") log("upstream.start", { id, connector, method, path, via });

  let status: number | undefined;
  let headersMs: number | undefined;
  let firstByteMs: number | undefined;
  let bytes = 0;
  let lastChunkAt = startedAt;
  let clientGone = false;
  let upstreamError: unknown;
  let done = false;

  // Closed before the reply was fully written, and not because the model
  // server's body broke (the pipeline closes the response then): the other
  // side went away.
  res.on("close", () => {
    if (!res.writableFinished && upstreamError === undefined) clientGone = true;
  });

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      const now = Date.now();
      firstByteMs ??= now - startedAt;
      bytes += chunk.length;
      lastChunkAt = now;
      cb(null, chunk);
    },
  });

  const finish = (outcome: string, extra: Record<string, unknown> = {}) => {
    if (done) return;
    done = true;
    open.delete(id);
    const ms = Date.now() - startedAt;
    if (outcome === "done" && (method === "GET" || method === "HEAD") && ms < SLOW_MS) return;
    log("upstream.end", {
      id,
      outcome,
      connector,
      method,
      path,
      via,
      ...(status !== undefined ? { status } : {}),
      ms,
      ...(headersMs !== undefined ? { headersMs } : {}),
      ...(firstByteMs !== undefined ? { firstByteMs } : {}),
      bytes,
      ...(outcome === "upstream-error" || outcome === "client-closed" ? { idleMs: Date.now() - lastChunkAt } : {}),
      ...extra,
    });
  };

  return {
    counter,
    watch(body) {
      body.once("error", (e) => {
        if (!clientGone) upstreamError = e ?? "error";
      });
    },
    answered(s) {
      status = s;
      headersMs = Date.now() - startedAt;
    },
    failed(e) {
      finish(clientGone ? "client-closed" : "connect-failed", { phase: "before-answer", ...errorFields(e) });
    },
    end(error) {
      if (clientGone) return finish("client-closed");
      const e = upstreamError ?? error;
      if (e !== undefined) return finish("upstream-error", errorFields(e));
      finish("done");
    },
  };
}
