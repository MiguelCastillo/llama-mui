// The only place the server makes a web request. Every request is written to the
// audit log as one 'io.fetch' line: why it was made (a short constant the caller
// gives), what caused it (from auditContext), the method, the host, the path,
// the answer's status and how long the answer took to start.
//
// What never goes in the line: the query string (it often holds keys or what
// the user searched for), headers, the body sent or the body received.
//
// The line is written when the response headers arrive, or when the request
// fails, so a streaming reply is handed back untouched and unbuffered. `ms` is
// the time to the first answer, not the end of the stream.
//
// The shape is `auditedFetch(url, init, { why })`: the last argument is the
// audit's own, so a plugin can later reach this over a message channel with
// plain data and without ever holding the global fetch.

import { audit, noteSession } from "../audit.ts";
import { currentCause } from "../auditContext.ts";
import type { Why } from "./exec.ts";

function errorName(e: any): string {
  const code = e?.cause?.code ?? e?.cause?.errors?.find?.((x: any) => x?.code)?.code ?? e?.code;
  return typeof code === "string" ? code : typeof e?.name === "string" ? e.name : "error";
}

export async function auditedFetch(url: string | URL, init: RequestInit | undefined, { why }: Why): Promise<Response> {
  const { session, call, request } = currentCause();
  if (session) noteSession(session);
  const started = Date.now();
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.host;
    path = u.pathname;
  } catch {
    // An invalid URL makes fetch throw below; the line then has no host.
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const write = (end: { status?: number; error?: string }) =>
    audit("io.fetch", {
      why,
      ...(session ? { session } : {}),
      ...(call ? { call } : {}),
      ...(request ? { request } : {}),
      method,
      host,
      path,
      ...(end.status !== undefined ? { status: end.status } : {}),
      ms: Date.now() - started,
      ...(end.error ? { error: end.error } : {}),
    });
  try {
    const res = await fetch(url, init);
    write({ status: res.status });
    return res;
  } catch (e) {
    write({ error: errorName(e) });
    throw e;
  }
}
