// Small request/response helpers shared by the /api route modules.

import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  status: number;
  // More fields for the JSON answer, next to `error` (a 409 carries the current revision).
  extra: Record<string, unknown>;
  // Fields are written out, not constructor parameter properties, so Node can
  // run this file as it is (server/main.ts).
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req);
  try {
    return buf.length ? JSON.parse(buf.toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "Request body is not JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// What a route module gets: the path under /api split on "/", e.g.
// ["connectors", "<id>"].
export interface Route {
  req: IncomingMessage;
  res: ServerResponse;
  parts: string[];
  method: string;
  search: string;
}
