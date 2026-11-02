// Routes for the llama servers ("connectors") and the proxy that forwards the
// browser's API calls to them. The browser sees whether a key is set, never
// the key itself.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError, type Route, readBody, readJson, sendJson } from "./http.ts";
import { type Api, type Connector, type Store, load, save } from "./store.ts";

const apiOf = (c: { api?: Api }): Api => c.api ?? "anthropic";
const publicView = (c: Connector) => ({ id: c.id, name: c.name, url: c.url, hasKey: !!c.apiKey, api: apiOf(c) });

function readApi(raw: unknown): Api {
  if (raw === undefined || raw === "anthropic" || raw === "openai") return raw ?? "anthropic";
  throw new HttpError(400, 'api must be "anthropic" or "openai"');
}

// Accepts what people paste, e.g. "http://host:9931/v1/", and stores the root.
function normalizeUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new HttpError(400, "Enter a full URL, like http://192.168.1.20:8080");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "URL must start with http:// or https://");
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// Node's fetch reports network failures as codes on e.cause.
const NETWORK_ERRORS: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
  ECONNREFUSED: "connection refused (is the server running on that port?)",
  ENOTFOUND: "host not found",
  EAI_AGAIN: "host not found",
  EHOSTUNREACH: "host unreachable",
  ECONNRESET: "connection reset",
};
const describeNetworkError = (e: any) => NETWORK_ERRORS[e.cause?.code] ?? e.cause?.code ?? e.message;

// The key is the llama server's own (--api-key), which it takes as a bearer
// token whichever chat API is used. A server of another kind, like
// Anthropic's API, would bring its own.
const authHeaders = (apiKey: string): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

async function probe(url: string, apiKey: string) {
  try {
    const res = await fetch(`${url}/v1/models`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(5000) });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: apiKey ? "The server rejected the API key" : "The server needs an API key" };
    }
    if (!res.ok) return { ok: false, error: `Server answered ${res.status} ${res.statusText}` };
    const body = await res.json();
    return { ok: true, models: Array.isArray(body.data) ? body.data.length : 0 };
  } catch (e: any) {
    return { ok: false, error: e.name === "TimeoutError" ? "No answer within 5 seconds" : `Can't reach server: ${describeNetworkError(e)}` };
  }
}

function find(store: Store, id: string): Connector {
  const c = store.connectors.find((c) => c.id === id);
  if (!c) throw new HttpError(404, "No such connector");
  return c;
}

function nameOrHost(raw: unknown, url: string): string {
  return String(raw ?? "").trim() || new URL(url).host;
}

// Forwards /api/c/<id>/v1/... to that connector, streaming the reply so
// chat tokens arrive as they're generated.
async function proxy(req: IncomingMessage, res: ServerResponse, id: string, rest: string) {
  const c = find(await load(), id);
  const controller = new AbortController();
  // Closing the browser request (the Stop button) cancels generation upstream.
  res.on("close", () => controller.abort());

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${c.url}${rest}`, {
      method: req.method,
      headers: {
        ...authHeaders(c.apiKey),
        ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}),
        ...(typeof req.headers["anthropic-version"] === "string" && { "anthropic-version": req.headers["anthropic-version"] }),
        ...(typeof req.headers["anthropic-beta"] === "string" && { "anthropic-beta": req.headers["anthropic-beta"] }),
      },
      body: hasBody ? new Uint8Array(await readBody(req)) : undefined,
      signal: controller.signal,
    });
  } catch (e: any) {
    throw new HttpError(502, `Can't reach ${c.name}: ${describeNetworkError(e)}`);
  }
  res.statusCode = upstream.status;
  for (const h of ["content-type", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) return void res.end();
  // Rejects when the browser aborts mid-stream; nothing left to report then.
  await pipeline(Readable.fromWeb(upstream.body as any), res).catch(() => {});
}

// Handles /api/c/*, /api/active and /api/connectors/*; returns false for
// anything else.
export async function connectorRoutes({ req, res, parts, method, search }: Route): Promise<boolean> {
  if (parts[0] === "c" && parts[1] && parts[2] === "v1") {
    await proxy(req, res, parts[1], `/${parts.slice(2).join("/")}${search}`);
    return true;
  }

  if (parts[0] === "active" && method === "PUT") {
    const { id } = await readJson(req);
    const store = await load();
    find(store, id);
    store.activeId = id;
    await save(store);
    sendJson(res, 200, { activeId: id });
    return true;
  }

  if (parts[0] !== "connectors") return false;

  if (parts.length === 1 && method === "GET") {
    const store = await load();
    sendJson(res, 200, { activeId: store.activeId, connectors: store.connectors.map(publicView) });
    return true;
  }

  if (parts.length === 1 && method === "POST") {
    const body = await readJson(req);
    const url = normalizeUrl(body.url);
    const c: Connector = {
      id: randomUUID(),
      name: nameOrHost(body.name, url),
      url,
      apiKey: String(body.apiKey ?? "").trim(),
      api: readApi(body.api),
    };
    const store = await load();
    store.connectors.push(c);
    store.activeId ??= c.id;
    await save(store);
    sendJson(res, 201, publicView(c));
    return true;
  }

  // Tests saved settings ({id}), unsaved ones ({url, apiKey}), or an edit in
  // progress ({id, url}) where a blank key means "keep the saved one" and
  // clearKey means "try without one".
  if (parts[1] === "test" && method === "POST") {
    const body = await readJson(req);
    const saved = body.id ? find(await load(), body.id) : undefined;
    const url = body.url !== undefined ? normalizeUrl(body.url) : saved?.url;
    if (!url) throw new HttpError(400, "Missing url");
    const apiKey = body.clearKey ? "" : String(body.apiKey ?? "").trim() || saved?.apiKey || "";
    sendJson(res, 200, await probe(url, apiKey));
    return true;
  }

  if (parts.length === 2 && method === "PUT") {
    const body = await readJson(req);
    const store = await load();
    const c = find(store, parts[1]);
    c.url = normalizeUrl(body.url);
    c.name = nameOrHost(body.name, c.url);
    if (body.api !== undefined) c.api = readApi(body.api);
    // Omitted or blank keeps the saved key; clearKey removes it.
    if (body.clearKey) c.apiKey = "";
    else if (String(body.apiKey ?? "").trim()) c.apiKey = String(body.apiKey).trim();
    await save(store);
    sendJson(res, 200, publicView(c));
    return true;
  }

  if (parts.length === 2 && method === "DELETE") {
    const store = await load();
    find(store, parts[1]);
    store.connectors = store.connectors.filter((c) => c.id !== parts[1]);
    if (store.activeId === parts[1]) store.activeId = store.connectors[0]?.id ?? null;
    await save(store);
    sendJson(res, 200, { activeId: store.activeId });
    return true;
  }

  return false;
}
