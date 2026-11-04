import { useState, type ReactNode } from "react";
import { Box } from "@mui/material";
import { keyframes } from "@mui/material/styles";

// A crab for the empty chat, a sibling of the whale and the llama: it scuttles
// sideways above "How can I help you?" in quick bursts, legs pedalling; hover it
// and its claws snap. Same strip and placement as the others, so the message
// doesn't move.
const RANGE = 140; // px each side of centre on a wide screen; the strip scales it down on a narrow one

// A 24s cycle of twelve bursts of about a second: six to the right, then six back,
// with a pause between them. The crab never turns, it just goes sideways. Each
// burst starts at BURSTS[j] percent and lasts LEN percent.
const LEN = 4;
const BURSTS = Array.from({ length: 12 }, (_, j) => 2 + (j % 6) * 7.5 + (j >= 6 ? 50 : 0));
const pct = (n: number) => `${n.toFixed(2)}%`;

const scuttle = (() => {
  const f: Record<string, { transform: string }> = { "0%": { transform: `translateX(calc(var(--range) * -1))` } };
  const at = (px: number) => `translateX(calc(var(--range) * ${px / RANGE}))`;
  const x = (j: number) => (j < 6 ? -RANGE + ((j + 1) * 2 * RANGE) / 6 : RANGE - ((j - 5) * 2 * RANGE) / 6);
  BURSTS.forEach((s, j) => {
    f[pct(s)] = { transform: at(j === 0 || j === 6 ? (j === 0 ? -RANGE : RANGE) : x(j - 1)) };
    f[pct(s + LEN)] = { transform: at(x(j)) };
  });
  f["100%"] = { transform: `translateX(calc(var(--range) * -1))` };
  return keyframes(f);
})();

// Keyframes that move only during the bursts: `steps` swings in each one, from and
// back to rest, so legs and bounce stay in time with the scuttle.
const duringBursts = (steps: number, valueAt: (k: number) => string, rest: string) => {
  const f: Record<string, { transform: string }> = { "0%": { transform: rest }, "100%": { transform: rest } };
  BURSTS.forEach((s) => {
    for (let k = 0; k <= steps; k++) {
      f[pct(s + (LEN * k) / steps)] = { transform: k === 0 || k === steps ? rest : valueAt(k) };
    }
  });
  return keyframes(f);
};
const swing = (deg: number, flip: boolean, lag: number) => (k: number) =>
  `rotate(${((k + lag) % 2 === 0 ? 1 : -1) * (flip ? -1 : 1) * deg}deg)`;
// Two legs groups, half a stride apart (A and B). The lower segment bends at the
// knee a step after the upper one swings, so the foot lifts as the leg comes forward.
const upperA = duringBursts(6, swing(10, false, 0), "rotate(0deg)");
const upperB = duringBursts(6, swing(10, true, 0), "rotate(0deg)");
const lowerA = duringBursts(6, swing(14, false, 1), "rotate(0deg)");
const lowerB = duringBursts(6, swing(14, true, 1), "rotate(0deg)");
// Two little hops per burst.
const hop = duringBursts(4, (k) => (k % 2 === 1 ? "translateY(-2px)" : "translateY(0)"), "translateY(0)");
const sway = keyframes({
  "0%, 100%": { transform: "rotate(-5deg)" },
  "50%": { transform: "rotate(5deg)" },
});
const armSway = keyframes({
  "0%, 100%": { transform: "rotate(-2.5deg)" },
  "50%": { transform: "rotate(2.5deg)" },
});
// The upper pincer closes and opens twice; the ticks flash at each closing.
const snap = keyframes({
  "0%, 100%": { transform: "rotate(0deg)" },
  "20%, 60%": { transform: "rotate(28deg)" },
  "40%, 80%": { transform: "rotate(0deg)" },
});
const ticks = keyframes({
  "0%, 14%": { opacity: 0 },
  "20%": { opacity: 1 },
  "32%, 54%": { opacity: 0 },
  "60%": { opacity: 1 },
  "72%, 100%": { opacity: 0 },
});
// Reduced motion: the ticks only fade in and out.
const ticksFade = keyframes({ "0%, 100%": { opacity: 0 }, "40%, 60%": { opacity: 0.9 } });

const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };

const DARK = "color-mix(in srgb, currentColor 70%, black)";
const FEET = 63;
// Left legs: hip under the shell, knee out to the side, foot down on the ground.
const HIPS = [
  [30, 53],
  [36, 56],
  [42, 57],
] as const;

// The right side is the left one mirrored, so a rotation turns the other way there.
function Mirror({ on, children }: { on: boolean; children: ReactNode }) {
  return <g transform={on ? "translate(96 0) scale(-1 1)" : undefined}>{children}</g>;
}

// Two segments: the upper swings about the hip, the lower bends about the knee.
function Leg({ hx, hy, phase }: { hx: number; hy: number; phase: "A" | "B" }) {
  const kx = hx - 9;
  return (
    <g className={`upper up${phase}`} style={{ transformOrigin: `${hx}px ${hy}px` }}>
      <line x1={hx} y1={hy} x2={kx} y2={hy} />
      <g className={`lower lo${phase}`} style={{ transformOrigin: `${kx}px ${hy}px` }}>
        <line x1={kx} y1={hy} x2={hx - 12} y2={FEET} strokeWidth="2" />
      </g>
    </g>
  );
}

function Legs({ mirror, phases }: { mirror: boolean; phases: readonly ("A" | "B")[] }) {
  return (
    <Mirror on={mirror}>
      {HIPS.map(([hx, hy], i) => (
        <g key={hx} opacity={phases[i] === "A" ? 0.6 : 0.4}>
          <Leg hx={hx} hy={hy} phase={phases[i]} />
        </g>
      ))}
    </Mirror>
  );
}

// A thick arm with an elbow, and a claw of two pincers: one fixed, one hinged at the
// palm that swings shut. Drawn upright at the left; the tick marks sit by the tips.
function Claw({ mirror, snapNow, done }: { mirror: boolean; snapNow: () => void; done: () => void }) {
  return (
    <Mirror on={mirror}>
      <g className="arm" style={{ transformOrigin: "26px 45px", animationDelay: mirror ? "-1.2s" : undefined }}>
        <g opacity={0.75} fill="currentColor" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <line className="hit" onMouseEnter={snapNow} x1="26" y1="45" x2="13" y2="41" strokeWidth="4.6" />
          <line className="hit" onMouseEnter={snapNow} x1="13" y1="41" x2="9" y2="31" strokeWidth="4.6" />
          <g stroke="none">
            <ellipse className="hit" onMouseEnter={snapNow} cx="9" cy="28" rx="8" ry="6" />
            <path className="hit" onMouseEnter={snapNow} d="M9 26 C11 20 12 14 13 9 C15 15 16 21 15 27 Z" />
            <g className="pincer" style={{ transformOrigin: "8px 25px" }}>
              <path className="hit" onMouseEnter={snapNow} d="M8 26 C6 20 5 14 4 9 C2 15 1 21 3 27 Z" />
            </g>
          </g>
        </g>
        <g
          className="ticks"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          onAnimationEnd={(e) => e.target === e.currentTarget && done()}
        >
          <path d="M3 6 L0 2" />
          <path d="M14 5 L17 1" />
        </g>
      </g>
    </Mirror>
  );
}

function Eye({ x, delay }: { x: number; delay: string }) {
  return (
    <g className="stalk" style={{ transformOrigin: `${x}px 36px`, animationDelay: delay }}>
      <line x1={x} y1="36" x2={x} y2="29" stroke="currentColor" strokeOpacity={0.6} strokeWidth="2.2" strokeLinecap="round" />
      <circle className="eye" cx={x} cy="26" r="3.6" />
      <circle cx={x + 0.4} cy="26.4" r="1.5" style={{ fill: DARK }} />
    </g>
  );
}

export default function EmptyChatCrab() {
  // Hovering starts the snapping; it clears itself when the ticks' animation ends,
  // so it finishes even after the crab scuttles away from the pointer.
  const [snapping, setSnapping] = useState(false);
  const snapNow = () => setSnapping(true);
  const done = () => setSnapping(false);
  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        // 4rem tall (the crab is 64px); its bottom edge sits just above the heading, whatever height that wraps to.
        bottom: "calc(100% + 0.75rem)",
        left: 0,
        right: 0,
        height: "4rem",
        display: "flex",
        justifyContent: "center",
        // Only the crab's own shapes take the pointer.
        pointerEvents: "none",
        "--range": "min(8.75rem, calc(50vw - 4rem))",
        color: "primary.main",
      }}
    >
      <Box sx={{ animation: `${scuttle} 24s ease-in-out infinite`, ...still }}>
        <Box
          sx={(theme) => ({
            animation: `${hop} 24s ease-in-out infinite`,
            ...still,
            "& .upper, & .lower": { fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round" },
            "& .upA": { animation: `${upperA} 24s ease-in-out infinite`, ...still },
            "& .upB": { animation: `${upperB} 24s ease-in-out infinite`, ...still },
            "& .loA": { animation: `${lowerA} 24s ease-in-out infinite`, ...still },
            "& .loB": { animation: `${lowerB} 24s ease-in-out infinite`, ...still },
            "& .stalk": { animation: `${sway} 3s ease-in-out infinite`, ...still },
            "& .arm": { animation: `${armSway} 2.4s ease-in-out infinite`, ...still },
            "& .eye": { fill: theme.palette.background.paper },
            "& .shine": { stroke: theme.palette.background.paper, strokeOpacity: 0.3 },
            "& .hit": { pointerEvents: "auto" },
            "& .ticks": {
              opacity: 0,
              pointerEvents: "none",
              ...(snapping && {
                animation: `${ticks} 1s linear`,
                "@media (prefers-reduced-motion: reduce)": { animation: `${ticksFade} 1s linear` },
              }),
            },
            // Reduced motion: no snapping, the ticks only fade.
            "& .pincer": snapping ? { animation: `${snap} 1s ease-in-out`, ...still } : {},
          })}
        >
          {/* Drawn in a 96x64 box standing on y=64, seen from the front. The viewBox
              reaches 10 up for the claws' tick marks; the negative margin keeps the
              feet on the strip's bottom edge. */}
          <svg
            width="96"
            height="74"
            viewBox="0 -10 96 74"
            style={{ display: "block", marginTop: -10, overflow: "visible", pointerEvents: "none" }}
          >
            <Legs mirror={false} phases={["A", "B", "A"]} />
            <Legs mirror phases={["B", "A", "B"]} />
            {/* A wide, flat shell. */}
            <ellipse className="hit" onMouseEnter={snapNow} cx="48" cy="46" rx="26" ry="12" fill="currentColor" fillOpacity={0.6} />
            <path className="shine" d="M32 41 C38 36 46 35 54 35" fill="none" strokeWidth="1.4" strokeLinecap="round" />
            <Eye x={42} delay="0s" />
            <Eye x={54} delay="-1.2s" />
            <path className="shine" d="M43 52 C46 54 50 54 53 52" fill="none" strokeWidth="1" strokeLinecap="round" />
            <Claw mirror={false} snapNow={snapNow} done={done} />
            <Claw mirror snapNow={snapNow} done={done} />
          </svg>
        </Box>
      </Box>
    </Box>
  );
}
