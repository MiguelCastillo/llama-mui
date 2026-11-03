import { useState } from "react";
import { Box } from "@mui/material";
import { keyframes } from "@mui/material/styles";

// A snail for the empty chat, a sibling of EmptyChatWhale: a joke about slow
// local models. It crawls across and back above "How can I help you?" in about
// ninety seconds; hover it and it pulls into its shell, then comes back out.
// Same strip and placement as the whale, so the message doesn't move.
// How far it travels each side of centre: 140px, less on a narrow screen (the strip sets it).

// Drawn facing right; it flips by turning scaleX from 1 to -1 (and back) while
// it rests at each end, like the whale.
const crawl = keyframes({
  "0%": { transform: `translateX(calc(var(--range) * -1)) scaleX(1)` },
  "46%": { transform: `translateX(var(--range)) scaleX(1)` },
  "50%": { transform: `translateX(var(--range)) scaleX(-1)` },
  "96%": { transform: `translateX(calc(var(--range) * -1)) scaleX(-1)` },
  "100%": { transform: `translateX(calc(var(--range) * -1)) scaleX(1)` },
});
// The soft body stretches forward and gathers up again, tail fixed; the shell
// is not part of it, so it rides along.
const stretch = keyframes({
  "0%, 100%": { transform: "scale(1, 1)" },
  "50%": { transform: "scale(1.07, 0.96)" },
});
const sway = keyframes({
  "0%, 100%": { transform: "rotate(-6deg)" },
  "50%": { transform: "rotate(7deg)" },
});
// Pull in: the body shrinks toward the middle of the shell, holds, comes out.
const pullBody = keyframes({
  "0%, 100%": { transform: "scale(1, 1)" },
  "30%, 70%": { transform: "scale(0.3, 0.7)" },
});
// The stalks retract first and come out last.
const pullStalks = keyframes({
  "0%, 100%": { opacity: 1, transform: "scaleY(1)" },
  "20%, 78%": { opacity: 0, transform: "scaleY(0)" },
});
// Reduced motion: the stalks only fade.
const stalksFade = keyframes({ "0%, 100%": { opacity: 1 }, "30%, 70%": { opacity: 0 } });

const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };

// A long foot tapering to a tail at the left, rising into a rounded head at the right.
const BODY =
  "M2 48 C4 45 8 43 14 43 L68 43 C73 43 76 38 77 32 C78 26 83 24 86 26 C89 28 89 31 90 36 C91 41 92 44 90 46 C89 48 86 48 84 48 Z";
// The shell: a disc on the back with a spiral drawn on it.
const SPIRAL_INNER = "M38 27 a2 2 0 0 1 4 0 a4 4 0 0 1 -8 0 a6 6 0 0 1 12 0";
const SPIRAL_OUTER = "M46 27 a8 8 0 0 1 -16 0 a10 10 0 0 1 20 0 a12 12 0 0 1 -24 0 a14 14 0 0 1 28 0";

export default function EmptyChatSnail() {
  // Hovering starts the pull-in; it clears itself when the animation ends, so it
  // finishes even after the snail has crawled out from under the pointer.
  const [hiding, setHiding] = useState(false);
  const hide = () => setHiding(true);
  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        // 3rem tall (the snail is 48px); its bottom edge sits just above the heading, whatever height that wraps to.
        bottom: "calc(100% + 0.75rem)",
        left: 0,
        right: 0,
        height: "3rem",
        display: "flex",
        justifyContent: "center",
        // Only the snail's own shapes take the pointer.
        pointerEvents: "none",
        "--range": "min(140px, calc(50vw - 64px))",
        color: "primary.main",
      }}
    >
      <Box sx={{ animation: `${crawl} 90s ease-in-out infinite`, ...still }}>
        <Box
          sx={(theme) => ({
            "& .stretch": {
              transformOrigin: "2px 48px",
              animation: `${stretch} 3s ease-in-out infinite`,
              ...still,
            },
            // Scales toward the middle of the shell's underside.
            "& .body": {
              transformOrigin: "40px 45px",
              ...(hiding && { animation: `${pullBody} 1.2s ease-in-out`, ...still }),
            },
            "& .stalks": {
              transformOrigin: "83px 28px",
              ...(hiding && {
                animation: `${pullStalks} 1.2s ease-in-out`,
                "@media (prefers-reduced-motion: reduce)": { animation: `${stalksFade} 1.2s linear` },
              }),
            },
            "& .stalk": { animation: `${sway} 3.5s ease-in-out infinite`, ...still },
            "& .stalk.second": { animationDelay: "-1.4s" },
            "& .eye": { fill: theme.palette.background.paper },
            "& .whorl": { stroke: theme.palette.background.paper },
            "& .hit": { pointerEvents: "auto" },
          })}
        >
          <svg
            width="96"
            height="48"
            viewBox="0 0 96 48"
            style={{ display: "block", overflow: "visible", pointerEvents: "none" }}
          >
            <g className="stretch">
              <g className="body" onAnimationEnd={(e) => e.target === e.currentTarget && setHiding(false)}>
                <path className="hit" onMouseEnter={hide} d={BODY} fill="currentColor" fillOpacity={0.45} />
                {/* Eye stalks, each swaying about its base on the head. */}
                <g className="stalks">
                  <g className="stalk" style={{ transformOrigin: "80px 28px" }}>
                    <path className="hit" onMouseEnter={hide} d="M80 29 L78 13" stroke="currentColor" strokeOpacity={0.6} strokeWidth="2" strokeLinecap="round" fill="none" />
                    <circle cx="78" cy="12" r="2.2" fill="currentColor" fillOpacity={0.6} />
                    <circle className="eye" cx="78.4" cy="11.6" r="0.9" />
                  </g>
                  <g className="stalk second" style={{ transformOrigin: "86px 28px" }}>
                    <path className="hit" onMouseEnter={hide} d="M86 29 L89 14" stroke="currentColor" strokeOpacity={0.6} strokeWidth="2" strokeLinecap="round" fill="none" />
                    <circle cx="89" cy="13" r="2.2" fill="currentColor" fillOpacity={0.6} />
                    <circle className="eye" cx="89.4" cy="12.6" r="0.9" />
                  </g>
                </g>
              </g>
            </g>
            {/* The shell sits on the back, over the body. */}
            <circle className="hit" onMouseEnter={hide} cx="38" cy="27" r="18" fill="currentColor" fillOpacity={0.7} />
            <g className="whorl" fill="none" strokeWidth="1.4" strokeLinecap="round">
              <path d={SPIRAL_INNER} strokeOpacity={0.7} />
              <path d={SPIRAL_OUTER} strokeOpacity={0.35} />
            </g>
          </svg>
        </Box>
      </Box>
    </Box>
  );
}
