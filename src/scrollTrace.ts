// The scroll recorder's data: what one pinned send looked like, frame by
// frame, and a summary that names what moved when the message jumped. Pure:
// no React, no DOM. The page fills it (scrollRecorder.ts) and sends it to the
// server log as one `scroll.trace` line (server/scrollTrace.ts checks it).
// Numbers, timings and element labels only: never any text from the chat.

/**
 * Record every pinned send. Off by default: set to true to write scroll.trace
 * lines again while tracking down a jump or jitter, then set it back.
 */
export const SCROLL_TRACE_ON = false;
/** How long one recording lasts after a send, in ms. */
export const SCROLL_TRACE_MS = 4000;
export const SCROLL_TRACE_MAX_FRAMES = 360;
export const SCROLL_TRACE_MAX_CHANGES = 200;
export const SCROLL_TRACE_MAX_MARKS = 80;
/**
 * A label: letters, digits and : . _ # = - >, at most 60 characters. ">"
 * joins a turn to the piece inside it ("turn:12>DIV.MuiStack"); without it
 * every inner piece was logged as "other". No spaces, so no sentence fits.
 */
export const LABEL_SHAPE = /^[A-Za-z0-9:._#=>-]{1,60}$/;

/**
 * One animation frame. `off` is where the message's top is on screen relative
 * to its stop under the top bar: 0 is in place, negative is above it (past the
 * top bar), positive below. null when the message isn't drawn.
 */
export type TraceFrame = {
  t: number;
  st: number; // box scrollTop
  sh: number; // box scrollHeight
  ch: number; // box clientHeight
  off: number | null;
  mt: number | null; // message's offset in the content
  bt: number; // box's top on screen
  wy: number; // window.scrollY (the whole page moved)
  vt: number; // visualViewport.offsetTop
  vh: number; // visualViewport.height
  sp: number | null; // spacer height
  h: 0 | 1; // pin held
  s: 0 | 1; // pin at the top (scrolled)
  g: 0 | 1; // glide running
  f: 0 | 1; // following the bottom
};

/** Something in the message list changed size, appeared or went away. */
export type TraceChange = {
  t: number;
  kind: "resized" | "added" | "removed";
  what: string; // label, e.g. "turn:12", "plan", "turn:12>DIV"
  above: 0 | 1; // before the pinned message in the page
  dh: number; // change in height (resized), or the node's height (added/removed, 0 if unknown)
};

/** A moment the page itself acted: glide start/end, hold, release, unpin… */
export type TraceMark = { t: number; name: string };

export type Trace = {
  frames: TraceFrame[];
  changes: TraceChange[];
  marks: TraceMark[];
};

export type TraceSummary = {
  frames: number;
  /** The most negative `off`: how far past the top bar the message went. */
  worstOff: number | null;
  worstAt: number | null;
  /** The biggest one-frame jump of `off` after it first reached its stop. */
  biggestJump: number | null;
  jumpAt: number | null;
  /** Changes above the message within 120 ms before the worst moment or the jump. */
  suspects: { t: number; what: string; kind: TraceChange["kind"]; dh: number }[];
  /** The page itself scrolling (window.scrollY or the visual viewport moving). */
  pageMoved: number;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

export function createTrace(): Trace {
  return { frames: [], changes: [], marks: [] };
}

export function pushFrame(trace: Trace, f: TraceFrame): void {
  if (trace.frames.length >= SCROLL_TRACE_MAX_FRAMES) return;
  trace.frames.push({
    ...f,
    t: r1(f.t),
    st: r1(f.st),
    sh: r1(f.sh),
    ch: r1(f.ch),
    off: f.off === null ? null : r1(f.off),
    mt: f.mt === null ? null : r1(f.mt),
    bt: r1(f.bt),
    wy: r1(f.wy),
    vt: r1(f.vt),
    vh: r1(f.vh),
    sp: f.sp === null ? null : r1(f.sp),
  });
}

export function pushChange(trace: Trace, c: TraceChange): void {
  if (trace.changes.length >= SCROLL_TRACE_MAX_CHANGES) return;
  const what = LABEL_SHAPE.test(c.what) ? c.what : "other";
  trace.changes.push({ ...c, t: r1(c.t), dh: r1(c.dh), what });
}

export function pushMark(trace: Trace, m: TraceMark): void {
  if (trace.marks.length >= SCROLL_TRACE_MAX_MARKS) return;
  trace.marks.push({ t: r1(m.t), name: LABEL_SHAPE.test(m.name) ? m.name : "other" });
}

const WINDOW_MS = 120;

export function summarize(trace: Trace): TraceSummary {
  let worstOff: number | null = null;
  let worstAt: number | null = null;
  let biggestJump: number | null = null;
  let jumpAt: number | null = null;
  let arrived = false;
  let prev: TraceFrame | null = null;
  let pageMoved = 0;
  for (const f of trace.frames) {
    if (f.off !== null && (worstOff === null || f.off < worstOff)) {
      worstOff = f.off;
      worstAt = f.t;
    }
    // A jump counts only once the message had arrived in an earlier frame:
    // the glide's own last stretch is not a jump.
    if (prev && arrived && f.off !== null && prev.off !== null) {
      const d = Math.abs(f.off - prev.off);
      if (d > 1 && (biggestJump === null || d > biggestJump)) {
        biggestJump = r1(d);
        jumpAt = f.t;
      }
    }
    if (f.off !== null && Math.abs(f.off) <= 1) arrived = true;
    if (prev) pageMoved = Math.max(pageMoved, Math.abs(f.wy - prev.wy), Math.abs(f.vt - prev.vt));
    prev = f;
  }
  const moments = [worstOff !== null && worstOff < -1 ? worstAt : null, jumpAt].filter((t): t is number => t !== null);
  const suspects = trace.changes
    .filter((c) => c.above && moments.some((m) => c.t <= m + 1 && c.t >= m - WINDOW_MS))
    .map(({ t, what, kind, dh }) => ({ t, what, kind, dh }));
  return { frames: trace.frames.length, worstOff, worstAt, biggestJump, jumpAt, suspects, pageMoved: r1(pageMoved) };
}
