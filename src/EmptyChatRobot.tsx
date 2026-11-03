import { useState } from "react";
import { Box } from "@mui/material";
import { keyframes } from "@mui/material/styles";

// A robot for the empty chat, a sibling of EmptyChatWhale: it rolls slowly back
// and forth above "How can I help you?"; hover it and its antenna flashes and it
// says "beep". Same strip and placement as the llama, so the message doesn't move.
// How far it travels each side of centre: 140px, less on a narrow screen (the strip sets it).

// Two wrappers share one 30s cycle. The outer one only moves; the inner one only
// turns, from scaleX 1 to -1 (and back) while the robot stands at each end. The
// speech bubble lives in the outer one, so its text never mirrors.
const roll = keyframes({
  "0%": { transform: `translateX(calc(var(--range) * -1))` },
  "45%, 50%": { transform: `translateX(var(--range))` },
  "95%, 100%": { transform: `translateX(calc(var(--range) * -1))` },
});
const turn = keyframes({
  "0%, 45%": { transform: "scaleX(1)" },
  "50%, 95%": { transform: "scaleX(-1)" },
  "100%": { transform: "scaleX(1)" },
});
// A slight rock on the wheels, about the point where they touch the ground.
const wobble = keyframes({
  "0%, 100%": { transform: "rotate(-0.8deg)" },
  "50%": { transform: "rotate(0.8deg)" },
});
// One turn takes about as long as the robot needs to roll a wheel's circumference.
const spin = keyframes({ to: { transform: "rotate(360deg)" } });
const blink = keyframes({
  "0%, 93%, 100%": { transform: "scaleY(1)" },
  "96.5%": { transform: "scaleY(0.1)" },
});
const glow = keyframes({
  "0%, 100%": { opacity: 0.15, transform: "scale(0.8)" },
  "50%": { opacity: 0.45, transform: "scale(1.15)" },
});
// Three bright blinks.
const flash = keyframes({
  "0%, 4%": { opacity: 0 },
  "8%, 24%": { opacity: 1 },
  "30%, 40%": { opacity: 0 },
  "44%, 58%": { opacity: 1 },
  "64%, 74%": { opacity: 0 },
  "78%, 92%": { opacity: 1 },
  "100%": { opacity: 0 },
});
// The bubble pops in, holds, and fades.
const pop = keyframes({
  "0%": { opacity: 0, transform: "translateY(4px) scale(0.6)" },
  "12%": { opacity: 1, transform: "translateY(0) scale(1.06)" },
  "20%, 70%": { opacity: 1, transform: "translateY(0) scale(1)" },
  "100%": { opacity: 0, transform: "translateY(-2px) scale(1)" },
});
// Reduced motion: the bubble only fades in and out.
const popFade = keyframes({ "0%, 100%": { opacity: 0 }, "15%, 70%": { opacity: 1 } });

const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };

// Drawn in a 96x64 box standing on y=64, centred on x=48.
const WHEELS = [36, 60] as const;
const WHEEL_Y = 58;
const WHEEL_R = 6;

export default function EmptyChatRobot() {
  // Hovering starts the beep; it clears itself when the bubble's animation ends,
  // so it plays through even after the robot rolls out from under the pointer.
  const [beeping, setBeeping] = useState(false);
  const beep = () => setBeeping(true);
  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        // 4rem tall (the robot is 64px); its bottom edge sits just above the heading, whatever height that wraps to.
        bottom: "calc(100% + 0.75rem)",
        left: 0,
        right: 0,
        height: "4rem",
        display: "flex",
        justifyContent: "center",
        // Only the robot's own shapes take the pointer.
        pointerEvents: "none",
        "--range": "min(140px, calc(50vw - 64px))",
        color: "primary.main",
      }}
    >
      <Box
        sx={(theme) => ({
          position: "relative",
          animation: `${roll} 30s ease-in-out infinite`,
          ...still,
          "& .turn": { animation: `${turn} 30s ease-in-out infinite`, ...still },
          "& .wobble": {
            transformOrigin: "48px 64px",
            animation: `${wobble} 0.6s ease-in-out infinite`,
            ...still,
          },
          "& .wheel": {
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: `${spin} 1.8s linear infinite`,
            ...still,
          },
          "& .eyes": {
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: `${blink} 5s ease-in-out infinite`,
            ...still,
          },
          "& .glow": {
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: `${glow} 2.4s ease-in-out infinite`,
            ...still,
          },
          "& .flash": {
            opacity: 0,
            fill: theme.palette.warning.main,
            ...(beeping && {
              animation: `${flash} 1.4s linear`,
              "@media (prefers-reduced-motion: reduce)": { animation: "none" },
            }),
          },
          "& .eye": { fill: theme.palette.background.paper },
          "& .mouth": { stroke: theme.palette.background.paper, strokeOpacity: 0.8 },
          "& .panel": { fill: theme.palette.background.paper, fillOpacity: 0.35 },
          "& .spoke": { stroke: theme.palette.background.paper, strokeOpacity: 0.7 },
          "& .hit": { pointerEvents: "auto" },
          // Scales from the bottom centre of its box: the tail, over the head.
          "& .bubble": {
            opacity: 0,
            transformBox: "fill-box",
            transformOrigin: "50% 100%",
            pointerEvents: "none",
            ...(beeping && {
              animation: `${pop} 1.4s ease-out`,
              "@media (prefers-reduced-motion: reduce)": { animation: `${popFade} 1.4s linear` },
            }),
          },
          "& .bubbleBox": { fill: theme.palette.background.paper },
          "& .bubbleText": { fill: theme.palette.text.primary },
        })}
      >
        <Box className="turn">
          <Box className="wobble">
            <svg
              width="96"
              height="64"
              viewBox="0 0 96 64"
              style={{ display: "block", overflow: "visible", pointerEvents: "none" }}
            >
              <g className="hit" onMouseEnter={beep}>
                {/* Stubby arms, a bit paler. */}
                <g fill="currentColor" fillOpacity={0.45}>
                  <rect x="26" y="37" width="6" height="12" rx="3" />
                  <rect x="64" y="37" width="6" height="12" rx="3" />
                </g>
                {/* Base, then the body with its chest panel. */}
                <rect x="29" y="49" width="38" height="7" rx="3.5" fill="currentColor" fillOpacity={0.8} />
                <rect x="33" y="35" width="30" height="17" rx="4" fill="currentColor" fillOpacity={0.6} />
                <rect className="panel" x="41" y="39" width="14" height="9" rx="2" />
                <circle cx="45.5" cy="43.5" r="1.4" fill="currentColor" fillOpacity={0.8} />
                <circle cx="50.5" cy="43.5" r="1.4" fill="currentColor" fillOpacity={0.8} />
                {/* Wheels: a tyre, and spokes that turn as it rolls. */}
                {WHEELS.map((x) => (
                  <g key={x}>
                    <circle cx={x} cy={WHEEL_Y} r={WHEEL_R} fill="currentColor" fillOpacity={0.9} />
                    <g className="wheel" strokeWidth="1.2" strokeLinecap="round">
                      <line className="spoke" x1={x - 3.8} y1={WHEEL_Y} x2={x + 3.8} y2={WHEEL_Y} />
                      <line className="spoke" x1={x} y1={WHEEL_Y - 3.8} x2={x} y2={WHEEL_Y + 3.8} />
                    </g>
                  </g>
                ))}
                {/* Antenna with its glowing tip. */}
                <line x1="48" y1="10" x2="48" y2="4" stroke="currentColor" strokeOpacity={0.6} strokeWidth="1.8" strokeLinecap="round" />
                <circle className="glow" cx="48" cy="3" r="5" fill="currentColor" />
                <circle cx="48" cy="3" r="2.6" fill="currentColor" fillOpacity={0.9} />
                <circle className="flash" cx="48" cy="3" r="3.4" />
                {/* Ears and the rounded-square head. */}
                <g fill="currentColor" fillOpacity={0.45}>
                  <rect x="24.5" y="17" width="4" height="9" rx="2" />
                  <rect x="67.5" y="17" width="4" height="9" rx="2" />
                </g>
                <rect x="28" y="9" width="40" height="25" rx="8" fill="currentColor" fillOpacity={0.6} />
                {/* Big round eyes that blink, and a small mouth line. */}
                <g className="eyes">
                  <circle className="eye" cx="39.5" cy="20" r="4.8" />
                  <circle className="eye" cx="56.5" cy="20" r="4.8" />
                  <circle cx="40.6" cy="20.4" r="2" fill="currentColor" fillOpacity={0.85} />
                  <circle cx="57.6" cy="20.4" r="2" fill="currentColor" fillOpacity={0.85} />
                </g>
                <path className="mouth" d="M43 28.5 H53" fill="none" strokeWidth="1.2" strokeLinecap="round" />
              </g>
            </svg>
          </Box>
        </Box>
        {/* The bubble is outside the turning wrapper, so the text never mirrors. It
            sits above the head, which is centred in the box whichever way it faces. */}
        <svg
          width="96"
          height="36"
          viewBox="0 0 96 36"
          style={{ position: "absolute", left: 0, top: -37, overflow: "visible", pointerEvents: "none" }}
        >
          <g
            className="bubble"
            onAnimationEnd={(e) => e.target === e.currentTarget && setBeeping(false)}
          >
            <path
              className="bubbleBox"
              d="M34 2 H62 A6 6 0 0 1 68 8 V20 A6 6 0 0 1 62 26 H53 L48 33 L43 26 H34 A6 6 0 0 1 28 20 V8 A6 6 0 0 1 34 2 Z"
              stroke="currentColor"
              strokeOpacity={0.5}
              strokeWidth="1"
              strokeLinejoin="round"
            />
            <text
              className="bubbleText"
              x="48"
              y="14.5"
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="12"
              fontWeight="600"
              fontFamily="inherit"
            >
              beep
            </text>
          </g>
        </svg>
      </Box>
    </Box>
  );
}
