import { useState } from "react";
import { Box } from "@mui/material";
import { keyframes } from "@mui/material/styles";

// A small whale above "How can I help you?" on the empty chat, swimming slowly
// across and back; hover it and it blows a spout. CSS keyframes do the moving
// (a flag only starts the spout, see below). Absolutely placed in a reserved
// strip, so the message doesn't move.
// How far it travels each side of centre: 140px, less on a narrow screen (the strip sets it).

// The whale is drawn facing right. It flips by turning scaleX from 1 to -1 (and
// back) while it stands at each end, so it faces the way it swims.
const swim = keyframes({
  "0%": { transform: `translateX(calc(var(--range) * -1)) scaleX(1)` },
  "45%": { transform: `translateX(var(--range)) scaleX(1)` },
  "50%": { transform: `translateX(var(--range)) scaleX(-1)` },
  "95%": { transform: `translateX(calc(var(--range) * -1)) scaleX(-1)` },
  "100%": { transform: `translateX(calc(var(--range) * -1)) scaleX(1)` },
});
const bob = keyframes({
  "0%, 100%": { transform: "translateY(0)" },
  "50%": { transform: "translateY(-5px)" },
});
const wag = keyframes({
  "0%, 100%": { transform: "rotate(-6deg)" },
  "50%": { transform: "rotate(8deg)" },
});
// The jets grow from the blowhole, spread a little, then fade.
const spout = keyframes({
  "0%": { opacity: 0, transform: "scale(0.1)" },
  "25%": { opacity: 0.9, transform: "scale(1)" },
  "60%": { opacity: 0.7, transform: "scale(1.1, 1.05)" },
  "100%": { opacity: 0, transform: "scale(1.25, 1.05)" },
});
// Droplets rise, then fall.
const drop = keyframes({
  "0%": { opacity: 0, transform: "translateY(0)" },
  "35%": { opacity: 0.8, transform: "translateY(-6px)" },
  "100%": { opacity: 0, transform: "translateY(9px)" },
});
// Reduced motion: the spout only fades in and out.
const spoutFade = keyframes({ "0%, 100%": { opacity: 0 }, "40%, 60%": { opacity: 0.8 } });

// Long body, big head on the right, a flat underside tapering to a tail stock
// that curves up at the left.
const BODY =
  "M86 25 C86 14 76 8 62 8 C48 8 34 12 24 19 C18 18 12 17 9 13 L13 17 C20 23 28 33 40 36 C54 38 74 37 82 31 C85 29 86 27 86 25 Z";

const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };

export default function EmptyChatWhale() {
  // Hovering starts the spout; it clears itself when the animation ends, so it
  // plays through even after the whale swims out from under the pointer.
  const [blowing, setBlowing] = useState(false);
  const blow = () => setBlowing(true);
  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        // 44px tall (the whale); its bottom edge sits just above the heading, whatever height that wraps to.
        bottom: "calc(100% + 0.75rem)",
        left: 0,
        right: 0,
        height: "2.75rem",
        display: "flex",
        justifyContent: "center",
        // Only the whale itself (its paths) takes the pointer.
        pointerEvents: "none",
        "--range": "min(140px, calc(50vw - 64px))",
        color: "primary.main",
      }}
    >
      <Box sx={{ animation: `${swim} 28s ease-in-out infinite`, ...still }}>
        <Box
          sx={(theme) => ({
            animation: `${bob} 4s ease-in-out infinite`,
            ...still,
            "& .tail": {
              transformOrigin: "11px 15px",
              animation: `${wag} 2s ease-in-out infinite`,
              ...still,
            },
            "& .eye": { fill: theme.palette.background.paper },
            "& .mouth": { stroke: theme.palette.background.paper, strokeOpacity: 0.8 },
            "& .belly": { fill: theme.palette.background.paper, fillOpacity: 0.35 },
            "& .hit": { pointerEvents: "auto" },
            // Scales from the bottom centre of its box: the blowhole.
            "& .spout": {
              opacity: 0,
              transformBox: "fill-box",
              transformOrigin: "50% 100%",
              pointerEvents: "none",
              ...(blowing && {
                animation: `${spout} 1s ease-out`,
                "@media (prefers-reduced-motion: reduce)": { animation: `${spoutFade} 1s linear` },
              }),
            },
            "& .drop": blowing ? { animation: `${drop} 1s ease-in`, ...still } : {},
          })}
        >
          {/* Drawn in an 88x44 box facing right. The viewBox reaches 30 up for the
              spout; the negative margin keeps the whale where the box would be. */}
          <svg
            width="88"
            height="74"
            viewBox="0 -30 88 74"
            style={{ display: "block", marginTop: -30, overflow: "visible", pointerEvents: "none" }}
          >
            <defs>
              <clipPath id="whale-body">
                <path d={BODY} />
              </clipPath>
            </defs>
            <path className="hit" onMouseEnter={blow} d={BODY} fill="currentColor" fillOpacity={0.6} />
            {/* Pale belly with throat grooves, kept inside the body. */}
            <g clipPath="url(#whale-body)">
              <path className="belly" d="M90 27 C80 30 70 30 62 30 C48 31 34 31 22 26 L22 46 L90 46 Z" />
              <g fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth="0.7" strokeLinecap="round">
                <path d="M64 30.5 C66 33 66 35 65 37" />
                <path d="M70 30.5 C72 33 72 35 71 37" />
                <path d="M76 30 C78 32 78 34 77.5 35.5" />
              </g>
            </g>
            {/* Pectoral fin, a bit darker than the body. */}
            <path
              className="hit"
              onMouseEnter={blow}
              d="M54 31 C52 36 48 41 42 43 C45 38 47 34 47 31 Z"
              fill="currentColor"
              fillOpacity={0.85}
            />
            {/* Tail flukes, wagging about where they join the tail stock. */}
            <g className="tail">
              <path
                className="hit"
                onMouseEnter={blow}
                d="M9 15 C6 11 2 8 0 0 C5 2 8 4 10.5 7 C13 4 17 1 23 0 C21 8 16 12 13 16 Z"
                fill="currentColor"
                fillOpacity={0.6}
              />
            </g>
            <path className="mouth" d="M85.5 25.5 C78 29 70 29 62 27" fill="none" strokeWidth="0.9" strokeLinecap="round" />
            <circle className="eye" cx="65" cy="23" r="1.8" />
            {/* Blowhole on top of the head, and the spout above it. It sits inside the
                flipped element, so it stays on the whale's back whichever way it faces. */}
            <ellipse cx="56" cy="8.8" rx="2.6" ry="1" fill="currentColor" fillOpacity={0.9} />
            <g
              className="spout"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              onAnimationEnd={(e) => e.target === e.currentTarget && setBlowing(false)}
            >
              {/* Drawn around (42, 7), moved onto the blowhole. */}
              <g transform="translate(5.6 0.1) scale(1.2)">
                <path d="M42 7 C42 0 42 -6 42 -13" strokeOpacity={0.5} />
                <path d="M42 7 C40 0 36 -6 33 -9" strokeOpacity={0.4} />
                <path d="M42 7 C44 0 48 -6 51 -9" strokeOpacity={0.4} />
                {[
                  [35, -13, 0],
                  [49, -13, 0.1],
                  [42, -18, 0.05],
                ].map(([x, y, delay]) => (
                  <circle
                    key={x}
                    className="drop"
                    cx={x}
                    cy={y}
                    r="1"
                    fill="currentColor"
                    stroke="none"
                    fillOpacity={0.5}
                    style={{ animationDelay: `${delay}s` }}
                  />
                ))}
              </g>
            </g>
          </svg>
        </Box>
      </Box>
    </Box>
  );
}
