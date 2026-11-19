// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { CHAT_GAP, CHAT_STRIP_FALLBACK, ChatLayout } from "../ChatLayout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom resolves rem and calc to px (1rem = 16px), so compare in px.
const REM_PX = 16;
const FALLBACK_PX = parseFloat(CHAT_STRIP_FALLBACK) * REM_PX;
const room = (stripPx: number) => `${stripPx + parseFloat(CHAT_GAP) * REM_PX}px`;

// The strip's measured height, and the observers the layout registered.
let stripPx = 80;
const callbacks: Array<() => void> = [];
const realRect = Element.prototype.getBoundingClientRect;
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

class FakeResizeObserver {
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    callbacks.push(cb);
  }
  observe() {}
  disconnect() {}
}

let host: HTMLDivElement;
let root: Root;

const mount = (narrow = false) => {
  act(() => {
    root.render(
      <ChatLayout
        narrow={narrow}
        maxWidth={800}
        messages={<p>the messages</p>}
        composer={<p data-testid="composer">the composer</p>}
        floating={<p data-testid="floating">jump</p>}
        anchored={<p data-testid="anchored">empty chat</p>}
      />,
    );
  });
};

const resizeStrip = (px: number) => {
  stripPx = px;
  act(() => callbacks.forEach((cb) => cb()));
};

// The scrolling box, and the boxes that wrap the jump button and the empty-chat block.
const scrollBox = () => [...host.querySelectorAll<HTMLElement>("div")].find((d) => getComputedStyle(d).overflowY === "auto")!;
const wrapperOf = (testid: string) => host.querySelector(`[data-testid=${testid}]`)!.parentElement as HTMLElement;

beforeEach(() => {
  stripPx = 80;
  callbacks.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  Element.prototype.getBoundingClientRect = function () {
    // Only the strip (the element holding the composer) has a measured height.
    const isStrip = this.querySelector("[data-testid=composer]") !== null && getComputedStyle(this).pointerEvents === "none";
    return { height: isStrip ? stripPx : 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Element.prototype.getBoundingClientRect = realRect;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
});

describe("ChatLayout with a measured strip", () => {
  for (const narrow of [false, true]) {
    const label = narrow ? "narrow" : "wide";

    it(`${label}: the scroll box's bottom padding is the strip height plus the gap`, () => {
      mount(narrow);
      const box = scrollBox();
      expect(getComputedStyle(box).paddingBottom).toBe(room(80));
      expect(getComputedStyle(box).getPropertyValue("scroll-padding-bottom")).toBe(room(80));
    });

    it(`${label}: a taller strip (message box grown) increases it, a shorter one decreases it`, () => {
      mount(narrow);
      resizeStrip(150);
      expect(getComputedStyle(scrollBox()).paddingBottom).toBe(room(150));
      resizeStrip(60);
      expect(getComputedStyle(scrollBox()).paddingBottom).toBe(room(60));
    });

    it(`${label}: the jump-button slot and the empty-chat anchor follow the strip`, () => {
      mount(narrow);
      expect(getComputedStyle(wrapperOf("floating")).bottom).toBe(room(80));
      expect(getComputedStyle(wrapperOf("anchored")).bottom).toBe(room(80));
      resizeStrip(150);
      expect(getComputedStyle(wrapperOf("floating")).bottom).toBe(room(150));
      expect(getComputedStyle(wrapperOf("anchored")).bottom).toBe(room(150));
    });
  }

  it("uses the fallback when ResizeObserver is missing", () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    mount();
    expect(getComputedStyle(scrollBox()).paddingBottom).toBe(room(FALLBACK_PX));
    expect(getComputedStyle(wrapperOf("anchored")).bottom).toBe(room(FALLBACK_PX));
  });

  it("lets clicks pass through the strip but not its content", () => {
    mount();
    const strip = host.querySelector("[data-testid=composer]")!.parentElement!.parentElement as HTMLElement;
    expect(getComputedStyle(strip).pointerEvents).toBe("none");
    expect(getComputedStyle(strip.firstElementChild as HTMLElement).pointerEvents).toBe("auto");
  });
});
