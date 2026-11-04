import { useState } from "react";
import { Box } from "@mui/material";
import { keyframes } from "@mui/material/styles";

// An owl for the empty chat, a sibling of EmptyChatWhale and EmptyChatLlama: the
// calm one. It perches on a short branch above "How can I help you?", blinks,
// glances about and tilts its head; hover it and it puffs up and says "hoo".
// Same strip bottom as the others, so the message doesn't move.

// The whole owl rocks a hair on the branch, about its feet.
const sway = keyframes({
  "0%, 100%": { transform: "rotate(-1.2deg)" },
  "50%": { transform: "rotate(1.2deg)" },
});
// The head turns a few degrees one way, rests, then the other, about the neck.
const tilt = keyframes({
  "0%, 8%": { transform: "rotate(0deg)" },
  "28%, 40%": { transform: "rotate(-8deg)" },
  "58%, 66%": { transform: "rotate(0deg)" },
  "84%, 92%": { transform: "rotate(8deg)" },
  "100%": { transform: "rotate(0deg)" },
});
// Lids close by squashing the eyes flat for an instant. A 10s cycle: one blink,
// and later a quick double.
const blink = keyframes({
  "0%, 38%, 41%, 82%, 84.5%, 88%, 90.5%, 100%": { transform: "scaleY(1)" },
  "39.5%, 83.2%, 89.2%": { transform: "scaleY(0.08)" },
});
// The pupils drift left, back, right, back, slowly.
const glance = keyframes({
  "0%, 15%, 50%, 85%, 100%": { transform: "translateX(0)" },
  "25%, 40%": { transform: "translateX(-2px)" },
  "60%, 75%": { transform: "translateX(2px)" },
});
// Hover: puff up with a small hop; the wings lift and settle.
const puff = keyframes({
  "0%, 100%": { transform: "scale(1) translateY(0)" },
  "25%": { transform: "scale(1.08) translateY(-2px)" },
  "55%": { transform: "scale(1.08) translateY(0)" },
  "70%": { transform: "scale(1.08) translateY(-1px)" },
});
const liftLeft = keyframes({
  "0%, 100%": { transform: "rotate(0deg)" },
  "25%, 65%": { transform: "rotate(12deg)" },
});
const liftRight = keyframes({
  "0%, 100%": { transform: "rotate(0deg)" },
  "25%, 65%": { transform: "rotate(-12deg)" },
});
// The bubble pops in, holds, then fades.
const pop = keyframes({
  "0%": { opacity: 0, transform: "scale(0.4)" },
  "20%": { opacity: 1, transform: "scale(1.08)" },
  "30%, 70%": { opacity: 1, transform: "scale(1)" },
  "100%": { opacity: 0, transform: "scale(1)" },
});
// Reduced motion: the bubble only fades in and out.
const bubbleFade = keyframes({ "0%, 100%": { opacity: 0 }, "25%, 70%": { opacity: 1 } });

const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };

// A darker tone than the body, for pupils, beak and feet.
const DARK = "color-mix(in srgb, currentColor 55%, black)";

const BODY = "M30 44 C30 28 38 22 48 22 C58 22 66 28 66 44 C66 56 58 63 48 63 C38 63 30 56 30 44 Z";
const WING_L = "M31 34 C25 40 25 54 33 60 C35 52 35 42 34 34 Z";
const WING_R = "M65 34 C71 40 71 54 63 60 C61 52 61 42 62 34 Z";

export default function EmptyChatOwl() {
  // Hovering starts the puff and the bubble; the flag clears when the bubble's
  // animation ends, so it plays through once per hover.
  const [hooting, setHooting] = useState(false);
  const hoot = () => setHooting(true);
  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        // 4.5rem tall (the owl is 72px); its bottom edge sits just above the heading, whatever height that wraps to.
        bottom: "calc(100% + 0.75rem)",
        left: 0,
        right: 0,
        height: "4.5rem",
        display: "flex",
        justifyContent: "center",
        // Only the owl's own shapes take the pointer.
        pointerEvents: "none",
        color: "primary.main",
      }}
    >
      <Box
        sx={(theme) => ({
          "& .perched": {
            transformOrigin: "48px 64px",
            animation: `${sway} 6s ease-in-out infinite`,
            ...still,
          },
          "& .body": {
            transformOrigin: "48px 64px",
            ...(hooting && { animation: `${puff} 1s ease-in-out`, ...still }),
          },
          "& .wingL": {
            transformOrigin: "32px 34px",
            ...(hooting && { animation: `${liftLeft} 1s ease-in-out`, ...still }),
          },
          "& .wingR": {
            transformOrigin: "64px 34px",
            ...(hooting && { animation: `${liftRight} 1s ease-in-out`, ...still }),
          },
          "& .head": {
            transformOrigin: "48px 38px",
            animation: `${tilt} 12s ease-in-out infinite`,
            ...still,
          },
          "& .eyes": {
            transformBox: "fill-box",
            transformOrigin: "50% 50%",
            animation: `${blink} 10s linear infinite`,
            ...still,
          },
          "& .pupil": {
            fill: DARK,
            animation: `${glance} 9s ease-in-out infinite`,
            ...still,
          },
          "& .eyewhite": { fill: theme.palette.background.paper },
          "& .belly": { fill: theme.palette.background.paper, fillOpacity: 0.35 },
          "& .beak, & .toe": { fill: DARK },
          "& .hit": { pointerEvents: "auto" },
          "& .bubble": {
            opacity: 0,
            transformOrigin: "48px 7px",
            pointerEvents: "none",
            ...(hooting && {
              animation: `${pop} 1s ease-out`,
              "@media (prefers-reduced-motion: reduce)": { animation: `${bubbleFade} 1s linear` },
            }),
          },
          "& .bubbleBox": { fill: theme.palette.background.paper, stroke: "currentColor", strokeOpacity: 0.5 },
          "& .bubbleText": { fill: theme.palette.text.primary },
        })}
      >
        {/* Drawn in a 96x72 box, the branch near the bottom. The viewBox reaches 24
            up for the bubble; the negative margin keeps the box 72 tall. */}
        <svg
          viewBox="0 -24 96 96"
          style={{ display: "block", width: "6rem", height: "6rem", marginTop: "-1.5rem", overflow: "visible", pointerEvents: "none" }}
        >
          {/* The branch: a slim rounded line with a couple of small leaves. */}
          <path
            d="M12 66 C30 64 62 68 84 65"
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.5}
            strokeWidth="3.4"
            strokeLinecap="round"
          />
          <g fill="currentColor" fillOpacity={0.45}>
            <ellipse cx="19" cy="62" rx="5" ry="2.2" transform="rotate(-35 19 62)" />
            <ellipse cx="78" cy="62" rx="5" ry="2.2" transform="rotate(30 78 62)" />
            <ellipse cx="86" cy="68" rx="4.5" ry="2" transform="rotate(50 86 68)" />
          </g>
          <g className="perched">
            {/* Feet gripping the branch. */}
            <g className="toe" stroke={DARK} strokeWidth="1.8" strokeLinecap="round" fill="none">
              <path d="M41 62 L40 66 M43.5 62 L43.5 66.5 M46 62 L47 66" />
              <path d="M50 62 L49 66 M52.5 62 L52.5 66.5 M55 62 L56 66" />
            </g>
            <g className="body">
              <path className="hit" onMouseEnter={hoot} d={BODY} fill="currentColor" fillOpacity={0.6} />
              {/* Lighter belly with a few feather marks. */}
              <ellipse className="belly" cx="48" cy="49" rx="10.5" ry="12.5" />
              <g fill="none" stroke="currentColor" strokeOpacity={0.45} strokeWidth="0.9" strokeLinecap="round">
                <path d="M42 45 q2.2 2.2 4.4 0 q2.2 2.2 4.4 0 q2.2 2.2 4.4 0" />
                <path d="M43.5 51 q2.2 2.2 4.4 0 q2.2 2.2 4.4 0" />
                <path d="M45 57 q2.2 2.2 4.4 0 q1.2 1.2 2.4 0" />
              </g>
              {/* Wings folded at the sides, a little darker than the body. */}
              <path className="hit wingL" onMouseEnter={hoot} d={WING_L} fill="currentColor" fillOpacity={0.85} />
              <path className="hit wingR" onMouseEnter={hoot} d={WING_R} fill="currentColor" fillOpacity={0.85} />
              <g className="head">
                {/* Ear tufts, then the round head over their bases. */}
                <path d="M32 24 L30 10 L43 18 Z" fill="currentColor" fillOpacity={0.75} />
                <path d="M64 24 L66 10 L53 18 Z" fill="currentColor" fillOpacity={0.75} />
                <ellipse className="hit" onMouseEnter={hoot} cx="48" cy="30" rx="19" ry="16" fill="currentColor" fillOpacity={0.6} />
                {/* Two big forward-facing eyes with pupils; they blink together. */}
                <g className="eyes">
                  <circle className="eyewhite" cx="40" cy="30" r="8" />
                  <circle className="eyewhite" cx="56" cy="30" r="8" />
                  <circle className="pupil" cx="40" cy="30.5" r="3.6" />
                  <circle className="pupil" cx="56" cy="30.5" r="3.6" />
                  <circle cx="41.2" cy="29" r="1" fill="#fff" fillOpacity={0.9} />
                  <circle cx="57.2" cy="29" r="1" fill="#fff" fillOpacity={0.9} />
                </g>
                {/* Small triangular beak between the eyes. */}
                <path className="beak" d="M45.5 34 L50.5 34 L48 39.5 Z" />
              </g>
            </g>
            {/* Speech bubble above the head: it sits in the perched group, so it rocks with the owl. */}
            <g
              className="bubble"
              onAnimationEnd={(e) => e.target === e.currentTarget && setHooting(false)}
            >
              <path
                className="bubbleBox"
                d="M38 -14 H58 Q62 -14 62 -10 V-2 Q62 2 58 2 H52 L48 7 L44 2 H38 Q34 2 34 -2 V-10 Q34 -14 38 -14 Z"
                strokeWidth="0.9"
                strokeLinejoin="round"
              />
              <text
                className="bubbleText"
                x="48"
                y="-3"
                textAnchor="middle"
                fontSize="9.5"
                fontWeight="600"
                fontFamily="inherit"
              >
                hoo
              </text>
            </g>
          </g>
        </svg>
      </Box>
    </Box>
  );
}
