import { useEffect, useState } from "react";

// The height the app should fill. Normally the full screen ("100dvh"). On a
// phone, the on-screen keyboard doesn't shrink the page: the browser slides
// the page up and draws the keyboard over the bottom of it, which cuts off the
// top and covers the last messages. While the keyboard is open, this is the
// space above it instead, so the page shrinks to fit.
//
// The space is read from the browser in pixels and given back in rem, so the
// styles stay in rem.

// How much shorter than the page the visible area must be to count as a
// keyboard. The browser's own bars (address bar, toolbar) are smaller than this.
const KEYBOARD_PX = 150;

// True while the visible area (keyboard included) is shorter than the given
// height in rem. Use this instead of a media query on screen height, which
// ignores the keyboard on some phones.
export function useVisibleShorterThan(rem: number): boolean {
  const read = () => {
    const vv = window.visualViewport;
    const px = vv ? vv.height : window.innerHeight;
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return px / remPx < rem;
  };
  const [short, setShort] = useState(read);
  useEffect(() => {
    const update = () => setShort(read());
    update();
    const vv = window.visualViewport;
    window.addEventListener("resize", update);
    vv?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rem]);
  return short;
}

export function useVisibleHeight(): string {
  const [height, setHeight] = useState("100dvh");
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      if (window.innerHeight - vv.height < KEYBOARD_PX) {
        setHeight("100dvh");
        return;
      }
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setHeight(`${vv.height / rem}rem`);
      // The browser may have slid the page up to show the text box; with the
      // page now fitting the visible area, put it back at the top.
      if (vv.offsetTop > 0) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return height;
}
