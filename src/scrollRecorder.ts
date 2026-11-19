// Records one pinned send for SCROLL_TRACE_MS: every animation frame (where
// the box is scrolled, where the message is against its stop, whether the
// whole page moved), every element of the message list that changed size,
// appeared or went away (by label, and whether it is above the message), and
// marks the chat makes (glide start/end, hold, release). Then it hands the
// trace and its summary to `send`. DOM only, no React. Never reads text.

import {
  createTrace,
  pushChange,
  pushFrame,
  pushMark,
  SCROLL_TRACE_MS,
  summarize,
  type Trace,
  type TraceFrame,
  type TraceSummary,
} from "./scrollTrace";

export type RecorderState = {
  box: HTMLElement | null;
  stack: HTMLElement | null;
  msg: HTMLElement | null;
  topRoom: number;
  msgTop: number | null;
  spacer: number | null;
  held: boolean;
  scrolled: boolean;
  gliding: boolean;
  following: boolean;
};

export type Recorder = { mark: (name: string) => void; stop: () => void };

// "turn:12" for a turn, "plan" for a plan card, else the tag, the first
// data-* name and the MUI component (from its class, e.g. MuiStack), so a
// piece can be found in the code. Never text from the page.
function label(el: Element): string {
  const h = el as HTMLElement;
  if (h.dataset?.turnStart !== undefined) return `turn:${h.dataset.turnStart}`;
  if (h.dataset?.planCard !== undefined) return "plan";
  const data = Object.keys(h.dataset ?? {})[0];
  const mui = Array.from(el.classList ?? []).find((c) => c.startsWith("Mui"))?.replace(/-root$/, "");
  return [el.tagName, data, mui].filter(Boolean).join(".");
}

// The stack's child that holds `node` (a turn or a card), and the label for
// the node within it ("turn:12>DIV.MuiStack").
function where(stack: HTMLElement, node: Node): { top: Element | null; what: string } {
  let n: Node | null = node;
  while (n && n.parentNode !== stack) n = n.parentNode;
  const top = n instanceof Element ? n : null;
  if (!top) return { top: null, what: "other" };
  const inner = node instanceof Element && node !== top ? `>${label(node)}` : node instanceof Element ? "" : ">text";
  return { top, what: `${label(top)}${inner}`.slice(0, 60) };
}

function isAbove(el: Element | null, msg: HTMLElement | null): 0 | 1 {
  if (!el || !msg || el === msg || el.contains(msg)) return 0;
  return el.compareDocumentPosition(msg) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0;
}

export function startRecorder(
  read: () => RecorderState,
  send: (trace: Trace, summary: TraceSummary) => void,
  now: () => number = () => performance.now(),
): Recorder {
  const began = now();
  const trace = createTrace();
  const at = () => now() - began;
  let done = false;
  let frame = 0;
  const heights = new Map<Element, number>();

  const first = read();
  const stack = first.stack;
  const sizes = new ResizeObserver((entries) => {
    const s = read();
    for (const e of entries) {
      const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
      const was = heights.get(e.target);
      heights.set(e.target, h);
      if (was === undefined || Math.abs(h - was) < 0.5) continue;
      pushChange(trace, { t: at(), kind: "resized", what: label(e.target), above: isAbove(e.target, s.msg), dh: h - was });
    }
  });
  const watch = (el: Element) => sizes.observe(el);
  if (stack) for (const child of Array.from(stack.children)) watch(child);
  const nodes = new MutationObserver((records) => {
    if (!stack) return;
    const s = read();
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        const { top, what } = where(stack, n);
        if (n.parentNode === stack && n instanceof Element) watch(n);
        const dh = n instanceof HTMLElement ? n.getBoundingClientRect().height : 0;
        pushChange(trace, { t: at(), kind: "added", what, above: isAbove(top, s.msg), dh });
      }
      for (const n of Array.from(r.removedNodes)) {
        // A removed node is no longer in the page; its parent still is.
        const { top, what } = where(stack, r.target);
        pushChange(trace, { t: at(), kind: "removed", what: `${what}>${n instanceof Element ? label(n) : "text"}`.slice(0, 60), above: isAbove(top, s.msg), dh: 0 });
      }
    }
  });
  if (stack) nodes.observe(stack, { childList: true, subtree: true });

  const sample = () => {
    const s = read();
    const box = s.box;
    if (!box) return;
    const bt = box.getBoundingClientRect().top;
    const off = s.msg ? s.msg.getBoundingClientRect().top - bt - s.topRoom : null;
    const vv = window.visualViewport;
    const f: TraceFrame = {
      t: at(),
      st: box.scrollTop,
      sh: box.scrollHeight,
      ch: box.clientHeight,
      off,
      mt: s.msgTop,
      bt,
      wy: window.scrollY,
      vt: vv?.offsetTop ?? 0,
      vh: vv?.height ?? window.innerHeight,
      sp: s.spacer,
      h: s.held ? 1 : 0,
      s: s.scrolled ? 1 : 0,
      g: s.gliding ? 1 : 0,
      f: s.following ? 1 : 0,
    };
    pushFrame(trace, f);
  };
  const loop = () => {
    if (done) return;
    sample();
    if (at() >= SCROLL_TRACE_MS) return stop();
    frame = requestAnimationFrame(loop);
  };
  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    sizes.disconnect();
    nodes.disconnect();
    sample();
    send(trace, summarize(trace));
  };
  pushMark(trace, { t: 0, name: "send" });
  sample();
  frame = requestAnimationFrame(loop);
  return {
    mark: (name) => {
      if (done) return;
      pushMark(trace, { t: at(), name });
      // A mark is also a moment worth a frame (it may fall between two).
      sample();
    },
    stop,
  };
}
