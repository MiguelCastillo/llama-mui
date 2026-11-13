import { useEffect, useState } from "react";
import { ButtonBase, Link, Popover, Stack, Tooltip, Typography } from "@mui/material";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import { type UsageReport, getUsage } from "./api";
import { formatTokens } from "./formatTokens";
import { limitLevel, limitMessage } from "./usageLimit";

const n = (v: number) => v.toLocaleString();

// A small button showing how many tokens this chat has used. Click for the
// breakdown. It loads again when the chat changes or `refreshKey` changes
// (the chat bumps it after each finished reply).
export default function ChatUsageButton({ sessionId, refreshKey = 0 }: { sessionId: string; refreshKey?: number }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let current = true;
    getUsage(sessionId)
      .then((r) => {
        if (!current) return;
        setReport(r);
        setError(null);
      })
      .catch((e) => current && setError(e?.message ?? "Could not load usage"));
    return () => {
      current = false;
    };
  }, [sessionId, refreshKey]);

  // A report for another chat must not show under this one while loading.
  useEffect(() => {
    setReport(null);
    setError(null);
  }, [sessionId]);

  const level = report ? limitLevel(report.today.total, report.dailyTokenLimit) : "none";
  const color = level === "over" ? "error.main" : level === "warn" ? "warning.main" : "text.secondary";
  const label = report ? formatTokens(report.session?.total ?? 0) : error ? "Usage" : "…";
  const message = report ? limitMessage(report.today.total, report.dailyTokenLimit) : null;

  return (
    <>
      <Tooltip title="Tokens used in this chat. Click for details.">
        <ButtonBase
          onClick={(e) => setAnchor(e.currentTarget)}
          aria-label="Token usage"
          sx={{ borderRadius: 1, px: 0.25, gap: 0.5, color, whiteSpace: "nowrap" }}
        >
          <DataUsageOutlinedIcon sx={{ fontSize: "0.85rem" }} />
          <Typography variant="caption" sx={{ lineHeight: 1 }}>
            {label}
          </Typography>
        </ButtonBase>
      </Tooltip>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: "22.5rem", maxWidth: "calc(100vw - 2rem)" } } }}
      >
        <Stack spacing={1} sx={{ p: 2, maxWidth: 320 }}>
          {error && <Typography color="error">{error}</Typography>}
          {!report && !error && <Typography color="text.secondary">Loading…</Typography>}
          {report && (
            <>
              <div>
                <Typography variant="subtitle2">This chat</Typography>
                <Typography variant="body2">
                  {n(report.session?.input ?? 0)} in · {n(report.session?.output ?? 0)} out · {n(report.session?.turns ?? 0)} turns
                </Typography>
              </div>
              <div>
                <Typography variant="subtitle2">Today</Typography>
                <Typography variant="body2">{n(report.today.total)} tokens</Typography>
                {report.dailyTokenLimit > 0 && (
                  <Typography color="text.secondary" variant="body2">
                    Daily limit: {n(report.dailyTokenLimit)} tokens
                  </Typography>
                )}
              </div>
              {message && (
                <Typography variant="body2" color={level === "over" ? "error" : "warning.main"}>
                  {message}
                </Typography>
              )}
            </>
          )}
          <Link href="#/settings/usage" variant="body2" onClick={() => setAnchor(null)}>
            Open usage details
          </Link>
        </Stack>
      </Popover>
    </>
  );
}
