import { useLayoutEffect, useState } from "react";
import type { ReactNode, Ref, UIEventHandler } from "react";
import { Box, Container, Paper } from "@mui/material";
import { useVisibleHeight } from "./useVisibleHeight";

// The shared values of the chat page layout. Change them only here:
//  - The scrolling box fills the whole column down to the bottom of the
//    visible height, so its scrollbar reaches the screen bottom. The strip with
//    the message box floats over its bottom edge.
//  - The strip's height is measured in one place (useStripHeight) because it
//    changes when the message box grows or the phone keyboard opens. Everything
//    that must clear the message box derives from it: END_ROOM is the strip's
//    height plus GAP (clear space above the box). It is the scrolling box's
//    bottom padding and the distance kept when scrolling something into view,
//    and it is where floating things (jump button, empty-chat block) sit.
//  - STRIP_FALLBACK is the strip's height used until it is measured, or where
//    ResizeObserver doesn't exist.
export const CHAT_GAP = "1.5rem";
// TOP_ROOM is the scrolling box's top padding: it keeps the first message clear
// of the floating toolbar, and it is where a just-sent message is pinned so the
// reply flows in below it.
export const CHAT_TOP_ROOM = "4.5rem";
export const CHAT_STRIP_FALLBACK = "7rem";
export const chatEndRoom = (strip: string) => `calc(${strip} + ${CHAT_GAP})`;

// The strip's height as a CSS length: measured in px (a computed value, not a
// written one), or the fallback while nothing is measured.
export const chatStripLength = (measuredPx: number | null) => (measuredPx === null ? CHAT_STRIP_FALLBACK : `${measuredPx}px`);

function useStripHeight(): [string, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [px, setPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setPx(el.getBoundingClientRect().height);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [chatStripLength(px), setEl];
}

type Props = {
  // The sessions list beside the chat column.
  sidebar?: ReactNode;
  // Things that sit over the chat column (toolbar, dialogs).
  top?: ReactNode;
  // The messages, inside the scrolling box.
  messages: ReactNode;
  // The message box, inside the transparent strip over the scrolling area's bottom.
  composer: ReactNode;
  // Floating over the chat, GAP above the message box, centred; takes no room.
  floating?: ReactNode;
  // Pinned GAP above the message box, inside the scrolling box (the empty chat).
  anchored?: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  narrow: boolean;
  // Max width of the strip's content, matching the messages.
  maxWidth: string | number;
};

export function ChatLayout({ sidebar, top, messages, composer, floating, anchored, scrollRef, onScroll, narrow, maxWidth }: Props) {
  // Sized from the visible height, which follows the phone keyboard, never
  // from the full screen.
  const height = useVisibleHeight();
  const [strip, stripRef] = useStripHeight();
  const endRoom = chatEndRoom(strip);
  return (
    <Box sx={{ display: "flex", height }}>
      {sidebar}
      <Box sx={{ flexGrow: 1, minWidth: 0, height, display: "flex", flexDirection: "column", position: "relative" }}>
        {top}
        <Box sx={{ flexGrow: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
          {/* Top padding keeps the first messages clear of the toolbar. */}
          <Box
            ref={scrollRef}
            onScroll={onScroll}
            sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto", pt: CHAT_TOP_ROOM, pb: endRoom, scrollPaddingBottom: endRoom, position: "relative" }}
          >
            {messages}
            {anchored && <Box sx={{ position: "absolute", bottom: endRoom, left: 0, right: 0 }}>{anchored}</Box>}
          </Box>
          {floating && (
            <Box sx={{ position: "absolute", bottom: endRoom, left: 0, right: 0, height: 0, display: "flex", justifyContent: "center", zIndex: 2 }}>
              {floating}
            </Box>
          )}
        </Box>
        {/* Transparent strip floating over the bottom of the chat. Clicks and
            the wheel pass through it to the chat; only the content inside takes them. */}
        <Paper
          ref={stripRef}
          square
          elevation={0}
          sx={{ pb: narrow ? 1 : 2, position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 1, bgcolor: "transparent", pointerEvents: "none" }}
        >
          <Container maxWidth={false} sx={{ maxWidth, pointerEvents: "auto", ...(narrow && { px: 1 }) }}>
            {composer}
          </Container>
        </Paper>
      </Box>
    </Box>
  );
}
