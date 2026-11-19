// POST /api/scroll-trace: one pinned send's scroll recording from the page
// (src/scrollRecorder.ts), written to the server log as one `scroll.trace`
// line. Only the fields of src/scrollTrace.ts are kept: numbers, 0/1 flags
// and short labels. Anything else is dropped, so no chat text can get in.

import { HttpError, type Route, readBody, sendJson } from "./http.ts";
import { log } from "./log.ts";
import { LABEL_SHAPE, SCROLL_TRACE_MAX_CHANGES, SCROLL_TRACE_MAX_FRAMES, SCROLL_TRACE_MAX_MARKS } from "../src/scrollTrace.ts";

export const SCROLL_TRACE_MAX_BYTES = 256 * 1024;

const SESSION = /^[A-Za-z0-9:-]{1,80}$/;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const flag = (v: unknown): 0 | 1 => (v === 1 || v === true ? 1 : 0);
const lbl = (v: unknown): string => (typeof v === "string" && LABEL_SHAPE.test(v) ? v : "other");
const list = (v: unknown, max: number): Record<string, unknown>[] =>
  Array.isArray(v) ? v.slice(0, max).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

const FRAME_NUMS = ["t", "st", "sh", "ch", "off", "mt", "bt", "wy", "vt", "vh", "sp"] as const;
const FRAME_FLAGS = ["h", "s", "g", "f"] as const;
const KINDS = new Set(["resized", "added", "removed"]);

/** The trace as it may go into the log, or an error message. */
export function cleanTrace(body: unknown): { ok: true; line: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.session !== "string" || !SESSION.test(b.session)) return { ok: false, error: "Expected a session id" };
  const frames = list(b.frames, SCROLL_TRACE_MAX_FRAMES).map((f) => {
    const out: Record<string, unknown> = {};
    for (const k of FRAME_NUMS) out[k] = num(f[k]);
    for (const k of FRAME_FLAGS) out[k] = flag(f[k]);
    return out;
  });
  const changes = list(b.changes, SCROLL_TRACE_MAX_CHANGES).map((c) => ({
    t: num(c.t),
    kind: typeof c.kind === "string" && KINDS.has(c.kind) ? c.kind : "other",
    what: lbl(c.what),
    above: flag(c.above),
    dh: num(c.dh),
  }));
  const marks = list(b.marks, SCROLL_TRACE_MAX_MARKS).map((m) => ({ t: num(m.t), name: lbl(m.name) }));
  const s = (b.summary && typeof b.summary === "object" ? b.summary : {}) as Record<string, unknown>;
  const summary = {
    frames: num(s.frames),
    worstOff: num(s.worstOff),
    worstAt: num(s.worstAt),
    biggestJump: num(s.biggestJump),
    jumpAt: num(s.jumpAt),
    pageMoved: num(s.pageMoved),
    suspects: list(s.suspects, 40).map((x) => ({
      t: num(x.t),
      what: lbl(x.what),
      kind: typeof x.kind === "string" && KINDS.has(x.kind) ? x.kind : "other",
      dh: num(x.dh),
    })),
  };
  return { ok: true, line: { session: b.session, summary, marks, changes, frames } };
}

export async function scrollTraceRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "scroll-trace" || parts.length !== 1 || method !== "POST") return false;
  const buf = await readBody(req);
  if (buf.length > SCROLL_TRACE_MAX_BYTES) throw new HttpError(413, "Scroll trace too large");
  let body: unknown;
  try {
    body = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not JSON");
  }
  const clean = cleanTrace(body);
  if (!clean.ok) throw new HttpError(400, clean.error);
  log("scroll.trace", clean.line);
  sendJson(res, 200, { ok: true });
  return true;
}
