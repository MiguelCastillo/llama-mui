import { useState } from "react";
import { Box } from "@mui/material";
import { keyframes } from "@mui/material/styles";

// A llama for the empty chat, a sibling of EmptyChatWhale: it walks slowly
// across and back above "How can I help you?"; hover it and it puffs hearts.
// Same strip and placement as the whale, so the message doesn't move.
// How far it travels each side of centre: 140px, less on a narrow screen (the strip sets it).

// Drawn facing right; it flips by turning scaleX from 1 to -1 (and back) while
// it stands at each end, like the whale.
const walk = keyframes({
  "0%": { transform: `translateX(calc(var(--range) * -1)) scaleX(1)` },
  "45%": { transform: `translateX(var(--range)) scaleX(1)` },
  "50%": { transform: `translateX(var(--range)) scaleX(-1)` },
  "95%": { transform: `translateX(calc(var(--range) * -1)) scaleX(-1)` },
  "100%": { transform: `translateX(calc(var(--range) * -1)) scaleX(1)` },
});
// Two bounces per stride.
const trot = keyframes({
  "0%, 100%": { transform: "translateY(0)" },
  "50%": { transform: "translateY(-2px)" },
});
// A walk of 1.5s: stance (foot on the ground, moving back under the body) for the
// first 60%, then the swing (foot forward). Each leg is two segments: the upper one
// swings about the hip, the lower one bends about the knee, a little after, so the
// foot lifts during the swing and straightens before it lands. Angles are CSS
// rotations: positive turns a hanging leg's foot backward.
const upperFront = keyframes({
  "0%": { transform: "rotate(-20deg)", animationTimingFunction: "linear" },
  "60%": { transform: "rotate(20deg)", animationTimingFunction: "ease-in-out" },
  "100%": { transform: "rotate(-20deg)" },
});
// The knee (carpus) folds the lower leg back.
const lowerFront = keyframes({
  "0%, 62%": { transform: "rotate(0deg)", animationTimingFunction: "ease-out" },
  "76%": { transform: "rotate(45deg)", animationTimingFunction: "ease-in" },
  "94%, 100%": { transform: "rotate(0deg)" },
});
// Back legs sit angled: thigh forward, lower leg back, bending at the hock.
const upperBack = keyframes({
  "0%": { transform: "rotate(-26deg)", animationTimingFunction: "linear" },
  "60%": { transform: "rotate(14deg)", animationTimingFunction: "ease-in-out" },
  "100%": { transform: "rotate(-26deg)" },
});
// The hock bends the other way from the knee: the foot comes up and forward.
const lowerBack = keyframes({
  "0%, 62%": { transform: "rotate(16deg)", animationTimingFunction: "ease-out" },
  "76%": { transform: "rotate(-28deg)", animationTimingFunction: "ease-in" },
  "94%, 100%": { transform: "rotate(16deg)" },
});
const twitch = keyframes({
  "0%, 70%, 100%": { transform: "rotate(0deg)" },
  "80%": { transform: "rotate(-14deg)" },
  "90%": { transform: "rotate(10deg)" },
});
// The hearts as a group fade in and out; each one also floats up and drifts.
const heartsFade = keyframes({ "0%": { opacity: 0 }, "15%, 65%": { opacity: 1 }, "100%": { opacity: 0 } });
const float = keyframes({
  "0%": { transform: "translate(0, 4px) scale(0.5)" },
  "100%": { transform: "translate(var(--dx), -12px) scale(1)" },
});

const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };

// Legs: [x, pair, near side?, back leg?]. A trot swings diagonal pairs together: back-near
// with front-far (legA), back-far with front-near (legB).
const LEGS = [
  [18, "legB", false, true],
  [26, "legA", true, true],
  [46, "legA", false, false],
  [54, "legB", true, false],
] as const;
const HIP = 42;
const KNEE = 53; // the carpus, or the hock
const FEET = 64;

// Fluffy body with a scalloped, cloud-like outline.
const BODY =
  "M62.0 30.0 Q66.6 34.1 58.5 36.5 Q58.4 41.2 49.0 41.3 Q44.2 45.3 36.0 43.0 Q27.8 45.3 23.0 41.3 Q13.6 41.2 13.5 36.5 Q5.4 34.1 10.0 30.0 Q5.4 25.9 13.5 23.5 Q13.6 18.8 23.0 18.7 Q27.8 14.7 36.0 17.0 Q44.2 14.7 49.0 18.7 Q58.4 18.8 58.5 23.5 Q66.6 25.9 62.0 30.0 Z";
// A long neck leaning forward, thick at the base and thin at the head.
const NECK = "M44 30 C50 20 60 8 69 -1 L77 3 C72 10 68 20 66 32 Z";
const HEART = "M0 0.8 C-2.8 -1.2 -1.6 -3.4 0 -2.2 C1.6 -3.4 2.8 -1.2 0 0.8 Z";

// Wool-coloured upper part, then a thinner, darker lower part with a hoof. The lower
// part is a child of the upper one, so it travels with it and bends at the knee.
const DARK = "color-mix(in srgb, currentColor 70%, black)";
function Leg({ x, pair, back }: { x: number; pair: string; back: boolean }) {
  return (
    <g className={`upper ${back ? "upperBack" : "upperFront"} ${pair}`} style={{ transformOrigin: `${x}px ${HIP}px` }}>
      <line x1={x} y1={HIP} x2={x} y2={KNEE} strokeWidth="4.6" />
      <g className={`lower ${back ? "lowerBack" : "lowerFront"}`} style={{ transformOrigin: `${x}px ${KNEE}px` }}>
        <line x1={x} y1={KNEE} x2={x} y2={FEET - 2} strokeWidth="2" stroke="currentColor" style={{ stroke: DARK }} />
        <rect x={x - 2.4} y={FEET - 3.2} width="4.8" height="3.2" rx="1.2" stroke="none" fill="currentColor" style={{ fill: DARK }} />
      </g>
    </g>
  );
}

export default function EmptyChatLlama() {
  // Hovering starts the hearts; it clears itself when their animation ends, so
  // they finish even after the llama walks away from the pointer.
  const [puffing, setPuffing] = useState(false);
  const puff = () => setPuffing(true);
  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        // 4rem tall (the llama is 64px); its bottom edge sits just above the heading,
        // whatever height that wraps to.
        bottom: "calc(100% + 0.75rem)",
        left: 0,
        right: 0,
        height: "4rem",
        display: "flex",
        justifyContent: "center",
        // Only the llama's own shapes take the pointer.
        pointerEvents: "none",
        "--range": "min(8.75rem, calc(50vw - 4rem))",
        color: "primary.main",
      }}
    >
      <Box sx={{ animation: `${walk} 36s ease-in-out infinite`, ...still }}>
        <Box
          sx={(theme) => ({
            animation: `${trot} 0.75s ease-in-out infinite`,
            ...still,
            "& .upperFront": { animation: `${upperFront} 1.5s infinite`, ...still },
            "& .lowerFront": { animation: `${lowerFront} 1.5s infinite`, ...still },
            "& .upperBack": { animation: `${upperBack} 1.5s infinite`, ...still },
            "& .lowerBack": { animation: `${lowerBack} 1.5s infinite`, ...still },
            // The other diagonal pair, half a stride on.
            "& .legB, & .legB .lower": { animationDelay: "-0.75s" },
            "& .tail": { transformOrigin: "13px 27px", animation: `${twitch} 4s ease-in-out infinite`, ...still },
            "& .eye": { fill: theme.palette.background.paper },
            "& .mouth": { stroke: theme.palette.background.paper, strokeOpacity: 0.8 },
            "& .hit": { pointerEvents: "auto" },
            "& .hearts": {
              opacity: 0,
              pointerEvents: "none",
              fill: theme.palette.error.main,
              ...(puffing && { animation: `${heartsFade} 1s ease-out` }),
            },
            // Reduced motion: the hearts only fade, they don't float.
            "& .heart": puffing
              ? { animation: `${float} 1s ease-out`, ...still }
              : {},
          })}
        >
          {/* Drawn in a 96x64 box standing on y=64, facing right. The viewBox reaches
              40 up for the hearts; the negative margin keeps the box 64 tall, so the
              feet stay on the strip's bottom edge. */}
          <svg
            width="96"
            height="104"
            viewBox="0 -40 96 104"
            style={{ display: "block", marginTop: -40, overflow: "visible", pointerEvents: "none" }}
          >
            {/* Far-side legs, paler. */}
            <g opacity={0.35} stroke="currentColor" strokeLinecap="round">
              {LEGS.filter(([, , near]) => !near).map(([x, pair, , back]) => (
                <Leg key={x} x={x} pair={pair} back={back} />
              ))}
            </g>
            <g className="tail">
              <path d="M12 29 C8 25 6 19 9 13 C12 17 14 21 15 25 Z" fill="currentColor" fillOpacity={0.55} />
            </g>
            {/* Face and ears: a darker tone than the wool. */}
            <g opacity={0.8} fill="currentColor">
              <g stroke="none">
                {/* Long banana ears, curving in toward each other. */}
                <path d="M73 -10 C70 -17 72 -24 77 -28 C77.5 -22 78 -15 78 -10 Z" />
                <path d="M84 -10 C87 -17 85 -24 80 -28 C79.5 -22 79 -15 79 -10 Z" />
                <g className="hit" onMouseEnter={puff}>
                  <ellipse cx="80" cy="-7" rx="8.5" ry="5" transform="rotate(15 80 -7)" />
                  <ellipse cx="86.5" cy="-3.5" rx="3.6" ry="3" />
                </g>
              </g>
            </g>
            {/* Wool: near legs, body, neck, and a tuft on the forehead between the ears. */}
            <g opacity={0.55} fill="currentColor" stroke="currentColor" strokeLinecap="round">
              {LEGS.filter(([, , near]) => near).map(([x, pair, , back]) => (
                <Leg key={x} x={x} pair={pair} back={back} />
              ))}
              <g stroke="none">
                <path className="hit" onMouseEnter={puff} d={NECK} />
                <path className="hit" onMouseEnter={puff} d={BODY} />
                <path d="M75 -9 Q76 -14 79 -12 Q82 -15 83.5 -9 Z" />
              </g>
            </g>
            {/* A hint of a split upper lip, and the eye, well back from the snout. */}
            <path className="mouth" d="M90 -4.8 C89.8 -3.5 89.3 -2.6 88.3 -1.9" fill="none" strokeWidth="0.7" strokeLinecap="round" />
            <circle className="eye" cx="76" cy="-8.5" r="1.5" />
            {/* Hearts above the head. They're inside the flipped element, so they stay over it. */}
            <g
              className="hearts"
              onAnimationEnd={(e) => e.target === e.currentTarget && setPuffing(false)}
            >
              {[
                [70, -22, -3, 0],
                [88, -22, 3, 0.1],
                [79, -35, 0, 0.2],
              ].map(([x, y, dx, delay]) => (
                <g key={x} transform={`translate(${x} ${y}) scale(1.4)`}>
                  <path
                    className="heart"
                    d={HEART}
                    style={{ ["--dx" as string]: `${dx}px`, animationDelay: `${delay}s` }}
                  />
                </g>
              ))}
            </g>
          </svg>
        </Box>
      </Box>
    </Box>
  );
}
