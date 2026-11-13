import { useEffect, useState } from "react";
import { Alert } from "@mui/material";
import { getUsage } from "./api";
import { limitLevel, limitMessage } from "./usageLimit";

// Notice for the daily token limit. Shows nothing unless a limit is set and
// today's total is near or past it. Refetches when `refreshKey` changes.
export default function UsageWarning({ refreshKey, sx }: { refreshKey?: unknown; sx?: object }) {
  const [state, setState] = useState<{ total: number; limit: number } | null>(null);

  useEffect(() => {
    let live = true;
    getUsage()
      .then((r) => live && setState({ total: r.today.total, limit: r.dailyTokenLimit }))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!state) return null;
  const level = limitLevel(state.total, state.limit);
  if (level === "none") return null;
  return (
    <Alert severity={level === "over" ? "error" : "warning"} variant={level === "over" ? "filled" : "standard"} sx={sx}>
      {limitMessage(state.total, state.limit)}
    </Alert>
  );
}
