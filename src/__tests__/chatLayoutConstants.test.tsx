import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CHAT_GAP, CHAT_STRIP_FALLBACK, ChatLayout, chatEndRoom, chatStripLength } from "../ChatLayout";

const rem = (v: string) => {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(v);
  if (!m) throw new Error(`not a plain rem value: ${v}`);
  return Number(m[1]);
};

// Drawn on the server: effects (and so the ResizeObserver) don't run, which is
// the "nothing measured yet / no ResizeObserver" case. The measured case, with
// a mocked ResizeObserver in jsdom, is in chatLayoutMeasured.test.tsx.
const draw = (narrow: boolean) =>
  renderToStaticMarkup(
    <ChatLayout
      narrow={narrow}
      maxWidth={800}
      messages={<p>the messages</p>}
      composer={<p>the composer</p>}
      floating={<p>jump</p>}
      anchored={<p>empty chat</p>}
    />,
  );

describe("chat layout shared values", () => {
  it("are plain rem values", () => {
    expect(rem(CHAT_GAP)).toBeGreaterThan(0);
    expect(rem(CHAT_STRIP_FALLBACK)).toBeGreaterThan(0);
  });

  it("builds the end room from the strip height and the gap", () => {
    expect(chatEndRoom("80px")).toBe(`calc(80px + ${CHAT_GAP})`);
  });

  it("uses the measured strip height, or the fallback when nothing is measured", () => {
    expect(chatStripLength(null)).toBe(CHAT_STRIP_FALLBACK);
    expect(chatStripLength(96)).toBe("96px");
  });

  it("gives more end room when the strip is taller (message box grown)", () => {
    expect(chatEndRoom(chatStripLength(150))).not.toBe(chatEndRoom(chatStripLength(80)));
    expect(chatEndRoom(chatStripLength(150))).toBe(`calc(150px + ${CHAT_GAP})`);
  });

  it("never leaves less end room than the strip itself", () => {
    // The end room is always the strip plus a positive gap.
    expect(rem(CHAT_GAP)).toBeGreaterThan(0);
    expect(chatEndRoom(CHAT_STRIP_FALLBACK)).toBe(`calc(${CHAT_STRIP_FALLBACK} + ${CHAT_GAP})`);
  });
});

describe("ChatLayout without a measurement (also where ResizeObserver is missing)", () => {
  for (const narrow of [false, true]) {
    it(`${narrow ? "narrow" : "wide"}: draws every slot`, () => {
      const html = draw(narrow);
      for (const text of ["the messages", "the composer", "jump", "empty chat"]) expect(html).toContain(text);
    });

    it(`${narrow ? "narrow" : "wide"}: bottom padding, scroll padding, jump slot and empty-chat anchor all use the fallback end room`, () => {
      const html = draw(narrow);
      const room = chatEndRoom(CHAT_STRIP_FALLBACK);
      // padding-bottom and scroll-padding-bottom on the scrolling box, then
      // `bottom` on the empty-chat anchor and on the jump slot.
      expect(html.split(`padding-bottom:${room}`).length - 1).toBeGreaterThanOrEqual(2); // padding-bottom + scroll-padding-bottom
      expect(html.split(`bottom:${room}`).length - 1).toBeGreaterThanOrEqual(2);
    });
  }

  it("lets clicks and the wheel pass through the transparent strip", () => {
    const html = draw(false);
    expect(html).toContain("pointer-events:none");
    expect(html).toContain("pointer-events:auto");
  });
});
