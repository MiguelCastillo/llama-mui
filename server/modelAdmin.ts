// Routes for llama server model management: listing, downloading, loading,
// unloading and deleting models. Each route is per-connector, adding that
// connector's API key like /api/c/<id>/v1/... does.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError, type Route, readJson, readBody, sendJson } from "./http.ts";
import { load, type Store } from "./store.ts";
import { track } from "./upstreamLog.ts";

const authHeaders = (apiKey: string): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

/**
 * Proxies a request to the llama server for a connector, adding its API key.
 * Handles streaming responses including SSE streams.
 */
async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  path: string,
  search?: string,
) {
  const c = find(await load(), id);
  // llama.cpp's own API: Anthropic's has no model manager to call.
  if (c.kind === "anthropic") throw new HttpError(400, "Only llama servers manage their models");
  let url = `${c.url}${path}`;
  if (search) url += search;

  // Abort on response close
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const tracked = track(req, res, c.name, `${path}`);
  let answered = false;
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        ...authHeaders(c.apiKey),
        ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}),
      },
      body: hasBody ? new Uint8Array(await readBody(req)) : undefined,
      signal: controller.signal,
    });
    answered = true;
    tracked.answered(upstream.status);
    res.statusCode = upstream.status;
    for (const h of ["content-type", "cache-control"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) {
      res.end();
      return tracked.end();
    }
    // Stream the response body (handles SSE)
    const body = Readable.fromWeb(upstream.body as any);
    tracked.watch(body);
    await pipeline(body, tracked.counter, res).then(
      () => tracked.end(),
      (e) => tracked.end(e),
    );
  } catch (e: any) {
    if (!answered) tracked.failed(e);
    throw new HttpError(502, `Can't reach ${c.name}: ${e.message ?? describeNetworkError(e)}`);
  }
}

function describeNetworkError(e: any): string {
  const NETWORK_ERRORS: Record<string, string> = {
    UND_ERR_CONNECT_TIMEOUT: "connection timed out",
    ECONNREFUSED: "connection refused (is the server running on that port?)",
    ENOTFOUND: "host not found",
    EAI_AGAIN: "host not found",
    EHOSTUNREACH: "host unreachable",
    ECONNRESET: "connection reset",
  };
  return NETWORK_ERRORS[e.cause?.code] ?? e.cause?.code ?? e.message;
}

function find(store: Store, id: string): any {
  const c = store.connectors.find((c: any) => c.id === id);
  if (!c) throw new HttpError(404, "No such connector");
  return c;
}

/**
 * Handles /api/c/<id>/models, /api/c/<id>/models/sse, /api/c/<id>/models/load,
 * /api/c/<id>/models/unload, /api/c/<id>/models/search, and DELETE /api/c/<id>/models?model=<id>.
 */
export async function modelAdminRoutes({ req, res, parts, method, search }: Route): Promise<boolean> {
  if (parts[0] !== "c" || !parts[1] || parts[2] !== "models") return false;

  const id = parts[1];

  // GET /models - list models on the server
  if (method === "GET" && parts.length === 3) {
    await proxy(req, res, id, "/models");
    return true;
  }

  // POST /models - start downloading a model in the background
  if (method === "POST" && parts.length === 3) {
    await proxy(req, res, id, "/models");
    return true;
  }

  // GET /models/sse - server-sent events for download progress
  if (method === "GET" && parts.length === 4 && parts[3] === "sse") {
    await proxy(req, res, id, "/models/sse");
    return true;
  }

  // POST /models/load - load a model
  if (method === "POST" && parts.length === 4 && parts[3] === "load") {
    await proxy(req, res, id, "/models/load");
    return true;
  }

  // POST /models/unload - unload a model
  if (method === "POST" && parts.length === 4 && parts[3] === "unload") {
    await proxy(req, res, id, "/models/unload");
    return true;
  }

  // DELETE /models?model=<id> - remove a model from cache
  if (method === "DELETE" && parts.length === 3) {
    // Pass the incoming query string through as-is (e.g., ?model=my-model)
    await proxy(req, res, id, "/models", search);
    return true;
  }

  // GET /models/search - search Hugging Face for GGUF models
  if (method === "GET" && parts.length === 4 && parts[3] === "search") {
    const query = new URLSearchParams(search).get("q");
    if (!query || query.trim() === "") {
      throw new HttpError(400, "Missing search query parameter 'q'");
    }
    // The 20 most downloaded: without a limit, Hugging Face returns up to 1,000.
    const hfUrl = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&limit=20`;
    try {
      const hfRes = await fetch(hfUrl);
      if (!hfRes.ok) {
        throw new HttpError(502, `Hugging Face API error: ${hfRes.status} ${hfRes.statusText}`);
      }
      const data = await hfRes.json();
      sendJson(res, 200, data);
    } catch (e: any) {
      throw new HttpError(502, `Can't reach Hugging Face: ${e.message ?? describeNetworkError(e)}`);
    }
    return true;
  }

  return false;
}
