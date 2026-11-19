import { describe, expect, it } from "vitest";
import {
  createTrace,
  pushChange,
  pushFrame,
  pushMark,
  SCROLL_TRACE_MAX_FRAMES,
  summarize,
  type TraceFrame,
} from "../scrollTrace";

const frame = (t: number, off: number | null, more: Partial<TraceFrame> = {}): TraceFrame => ({
  t, st: 100, sh: 2000, ch: 800, off, mt: 500, bt: 50, wy: 0, vt: 0, vh: 800, sp: 300, h: 1, s: 0, g: 1, f: 0, ...more,
});

describe("the scroll trace", () => {
  it("names a change above the message as the suspect when it overshoots", () => {
    const tr = createTrace();
    pushFrame(tr, frame(0, 160));
    pushFrame(tr, frame(16, 40));
    pushFrame(tr, frame(500, 0));
    pushChange(tr, { t: 590, kind: "resized", what: "plan", above: 1, dh: -31 });
    pushChange(tr, { t: 590, kind: "resized", what: "turn:40", above: 0, dh: 200 });
    pushFrame(tr, frame(600, -31));
    pushFrame(tr, frame(616, 0));
    const s = summarize(tr);
    expect(s.worstOff).toBe(-31);
    expect(s.worstAt).toBe(600);
    expect(s.biggestJump).toBe(31);
    expect(s.suspects).toEqual([{ t: 590, what: "plan", kind: "resized", dh: -31 }]);
  });

  it("says when the whole page moved", () => {
    const tr = createTrace();
    pushFrame(tr, frame(0, 0));
    pushFrame(tr, frame(16, -20, { wy: 20 }));
    expect(summarize(tr).pageMoved).toBe(20);
  });

  it("has no suspects when nothing overshot", () => {
    const tr = createTrace();
    pushFrame(tr, frame(0, 100));
    pushFrame(tr, frame(500, 0));
    pushChange(tr, { t: 400, kind: "added", what: "turn:41", above: 1, dh: 20 });
    expect(summarize(tr).suspects).toEqual([]);
  });

  it("keeps only safe labels and caps its size", () => {
    const tr = createTrace();
    pushChange(tr, { t: 1, kind: "added", what: "hello world, some text", above: 1, dh: 1 });
    pushChange(tr, { t: 1, kind: "removed", what: "turn:505>DIV.MuiStack>SPAN.liveLine", above: 0, dh: 0 });
    pushMark(tr, { t: 1, name: "hold:-12" });
    pushMark(tr, { t: 1, name: "a message's words" });
    expect(tr.changes[0].what).toBe("other");
    expect(tr.changes[1].what).toBe("turn:505>DIV.MuiStack>SPAN.liveLine");
    expect(tr.marks.map((m) => m.name)).toEqual(["hold:-12", "other"]);
    for (let i = 0; i < SCROLL_TRACE_MAX_FRAMES + 10; i++) pushFrame(tr, frame(i, 0));
    expect(tr.frames.length).toBe(SCROLL_TRACE_MAX_FRAMES);
  });

  it("rounds numbers to a tenth", () => {
    const tr = createTrace();
    pushFrame(tr, frame(1.234, -0.06, { st: 99.96 }));
    expect(tr.frames[0]).toMatchObject({ t: 1.2, off: -0.1, st: 100 });
  });
});
