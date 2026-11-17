// What the log (log.ts) says about each request llama-mui forwards to a model
// server, from the proxies in connectors.ts and modelAdmin.ts. One `upstream.end`
// line per request says how it ended:
//
//   done              the reply arrived whole
//   client-closed     whoever asked hung up first: the Stop button, a closed tab,
//                     a run that was stopped, or this server shutting down.
//                     `endedBy` says which when the run that cut it said so
//                     (stopped, restart, taken-over), else "unknown"
//   upstream-error    the model server's connection broke mid-reply (the error and
//                     its cause are in the line, and `idleMs` is how long it had been
//                     silent: a long gap before a break means it stalled first)
//   connect-failed    the model server couldn't be reached at all
//
// `via` is "browser" for a page and "server" for a call llama-mui made itself
// (plan runs and replies run here). Only what is safe to keep goes in: the
// connector's name, the path without its query, and numbers.
//
// A streamed reply on a wire's path (`/v1/messages` or `/v1/chat/completions`)
// also gets the model and its token counts, read by that wire's tap from the
// stream's own usage events:
// `tokens` is { input, cacheRead, cacheWrite, output }, which is what the bill
// is made of (cacheWrite costs more than input, cacheRead much less), and
// `cleared` says how many old tool results Anthropic left out of the request
// and how many tokens that saved. Nothing of the reply's text is kept.
//
// A reply's thinking blocks are sorted by the connector's own answer (see
// classifyThinking in src/connections/types.ts; the log judges nothing itself).
// `thinkingUnclassified` is how many the connection could not tell, present only
// when there were some: Claude marks a note for the user in a signature whose
// layout is not documented, so a block it can't read shows up here. The words
// of a block are never read or kept.
//
// A provider can also report a failure inside a stream that started fine (status
// 200, e.g. an overloaded_error): the line then has `streamError` { type,
// message } (the provider's own wording, cut short), and `stopReason` says why a
// reply that finished did so. `empty: true` marks a reply that ended with 0
// output tokens: the model sent nothing, which the status alone never shows.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { connection } from "../src/connections/index.ts";
import { messagesTap, tapForPath } from "../src/connections/tap.ts";
import type { Kind } from "../src/api.ts";
import { type EndKind } from "../src/runEnd.ts";
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

// Why a chat's requests were cut, as the run that cut them said (runners.ts calls
// noteAbort). The proxy only sees its connection close, so it finds the reason
// here by the chat the request named in x-llama-session. A reason counts only for
// requests that started before it was noted, so an old stop never explains a
// later hang-up.
const aborted = new Map<string, { kind: EndKind; at: number }>();
export const noteAbort = (session: string, kind: EndKind) => {
  aborted.set(session, { kind, at: Date.now() });
  if (aborted.size > 200) aborted.delete(aborted.keys().next().value as string);
};
const SESSION_SHAPE = /^[A-Za-z0-9:-]{1,80}$/;

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
  // The request's body as it was sent (bytes), so the log can see what the
  // request asked for. Only read for a streamed reply on a wire's path; a body
  // that isn't JSON is ignored.
  sent(body: Uint8Array): void;
  // The request never got an answer.
  failed(e: unknown): void;
  // The body has finished or broken: pass the error pipeline rejected with, if any.
  end(error?: unknown): void;
}

// What the log reads from a stream is the wire's own business (see tap.ts in
// src/connections): the same reader the tests use, kept under its old name.
export const usageReader = messagesTap;

// `kind` is the connector's kind, for asking its connection what a stream's
// thinking blocks are.
export function track(req: IncomingMessage, res: ServerResponse, connector: string, fullPath: string, kind?: Kind): Tracked {
  const id = `${Date.now().toString(36)}${(serial++ % 1296).toString(36).padStart(2, "0")}`;
  const path = fullPath.split("?")[0];
  const method = req.method ?? "GET";
  const startedAt = Date.now();
  const ua = String(req.headers["user-agent"] ?? "");
  const via = ua.startsWith("Mozilla") ? "browser" : "server";
  const named = req.headers["x-llama-session"];
  const session = typeof named === "string" && SESSION_SHAPE.test(named) ? named : undefined;
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
  // Token counts, for a reply on a wire's path (Messages or Chat Completions).
  const usage = method === "POST" ? tapForPath(path) : undefined;
  // The request's own fields (thinking settings and the like), once seen.
  let sentFields: Record<string, unknown> = {};

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
      usage?.feed(chunk);
      cb(null, chunk);
    },
  });

  // The reason the run gave for cutting this request, or "unknown": a hang-up
  // nobody explained (a closed tab, a dropped connection) is not guessed at.
  const endedBy = (): EndKind | "unknown" => {
    const why = session ? aborted.get(session) : undefined;
    return why && why.at >= startedAt ? why.kind : "unknown";
  };

  const finish = (outcome: string, extra: Record<string, unknown> = {}) => {
    if (done) return;
    done = true;
    open.delete(id);
    const ms = Date.now() - startedAt;
    if (outcome === "done" && (method === "GET" || method === "HEAD") && ms < SLOW_MS) return;
    const counted = usage?.result();
    // Thinking blocks the connection can't tell (never the words, see above).
    const unclassified = kind && counted?.thinking ? counted.thinking.filter((b) => connection(kind).classifyThinking(b, sentFields) === "unknown").length : 0;
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
      ...(outcome === "client-closed" ? { endedBy: endedBy() } : {}),
      ...(counted?.model ? { model: counted.model } : {}),
      ...(counted
        ? { tokens: { input: counted.input ?? 0, cacheRead: counted.cacheRead ?? 0, cacheWrite: counted.cacheWrite ?? 0, output: counted.output ?? 0 } }
        : {}),
      ...(counted?.streamError ? { streamError: counted.streamError } : {}),
      ...(counted?.stopReason ? { stopReason: counted.stopReason } : {}),
      ...(counted?.empty ? { empty: true } : {}),
      ...(unclassified ? { thinkingUnclassified: unclassified } : {}),
      ...(counted?.clearedToolUses ? { cleared: { toolUses: counted.clearedToolUses, tokens: counted.clearedTokens ?? 0 } } : {}),
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
    sent(body) {
      if (!usage || !kind) return;
      try {
        const parsed = JSON.parse(Buffer.from(body).toString());
        if (parsed && typeof parsed === "object") sentFields = parsed;
      } catch {
        // Not JSON: nothing to read.
      }
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
