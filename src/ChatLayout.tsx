import type { ReactNode, Ref, UIEventHandler } from "react";
import { Box, Container, Paper } from "@mui/material";
import { useVisibleHeight } from "./useVisibleHeight";

// The shared values of the chat page layout. They depend on each other, so
// change them together and only here:
//  - The scrolling area runs OVERLAP under the message box, so messages show
//    through the transparent strip and past the box's rounded corners.
//  - Floating things (jump button, empty-chat block) sit GAP above the message
//    box. Measured from the bottom of the scrolling area that is
//    OVERLAP + GAP (see ANCHOR_BOTTOM).
//  - SCROLL_PADDING is the room left under the last message and the distance
//    kept when scrolling something into view. It must be at least OVERLAP, or
//    the last line ends up behind the message box.
export const CHAT_OVERLAP = "2.5rem";
export const CHAT_GAP = "1.5rem";
export const CHAT_SCROLL_PADDING = "3rem";
export const CHAT_ANCHOR_BOTTOM = `calc(${CHAT_OVERLAP} + ${CHAT_GAP})`;

// How far the strip with the message box is pulled up over the scrolling
// area: the overlap plus the strip's own top padding (0.5rem on phones, 1rem
// otherwise) and, on wide screens, 1rem more.
const STRIP_PULL_NARROW = `calc(-1 * (${CHAT_OVERLAP} + 0.5rem))`;
const STRIP_PULL_WIDE = `calc(-1 * (${CHAT_OVERLAP} + 2rem))`;

type Props = {
  // The sessions list beside the chat column.
  sidebar?: ReactNode;
  // The work pane, on the right of the chat column.
  aside?: ReactNode;
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

export function ChatLayout({ sidebar, aside, top, messages, composer, floating, anchored, scrollRef, onScroll, narrow, maxWidth }: Props) {
  // Sized from the visible height, which follows the phone keyboard, never
  // from the full screen.
  const height = useVisibleHeight();
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
            sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto", pt: 9, pb: narrow ? 8 : 9, scrollPaddingBottom: CHAT_SCROLL_PADDING, position: "relative" }}
          >
            {messages}
            {anchored && <Box sx={{ position: "absolute", bottom: CHAT_ANCHOR_BOTTOM, left: 0, right: 0 }}>{anchored}</Box>}
          </Box>
          {floating && (
            <Box sx={{ position: "absolute", bottom: CHAT_ANCHOR_BOTTOM, left: 0, right: 0, height: 0, display: "flex", justifyContent: "center", zIndex: 2 }}>
              {floating}
            </Box>
          )}
        </Box>
        {/* Transparent strip over the bottom of the chat. Clicks and the wheel
            pass through it to the chat; only the content inside takes them. */}
        <Paper
          square
          elevation={0}
          sx={{ py: narrow ? 1 : 2, mt: narrow ? STRIP_PULL_NARROW : STRIP_PULL_WIDE, position: "relative", bgcolor: "transparent", pointerEvents: "none" }}
        >
          <Container maxWidth={false} sx={{ maxWidth, pointerEvents: "auto", ...(narrow && { px: 1 }) }}>
            {composer}
          </Container>
        </Paper>
      </Box>
      {aside}
    </Box>
  );
}
