import { useEffect, useState } from "react";
import { Typography, type TypographyProps } from "@mui/material";

export interface StreamRate {
  pieces: number;
  // performance.now() of the round's first piece; 0 until it arrives.
  first: number;
}

// Time since `since`, in whole seconds ("42s", "1m 05s"), updated every second,
// and with `rate`, the current round's tokens per second once it has streamed
// for a second (so the wait before the first token doesn't count). Other
// props go to the Typography.
export default function Elapsed({ since, rate, ...rest }: { since: number; rate?: { current: StreamRate } } & TypographyProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  const r = rate?.current;
  const streamedFor = r?.first ? (performance.now() - r.first) / 1000 : 0;
  const speed = r && streamedFor >= 1 ? ` · ${Math.round(r.pieces / streamedFor)} tps (client)` : "";
  return (
    <Typography component="span" variant="inherit" {...rest} sx={{ fontVariantNumeric: "tabular-nums", ...rest.sx }}>
      {sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`}
      {speed}
    </Typography>
  );
}
