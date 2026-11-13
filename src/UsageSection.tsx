import { useEffect, useState } from "react";
import { Alert, Box, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import { type UsageReport, type UsageTotals, getUsage } from "./api";
import { limitLevel, limitMessage } from "./usageLimit";
import { openChatHash, sessionFromHash } from "./sessionRoute";

const n = (v: number) => v.toLocaleString();

function Headline({ label, totals }: { label: string; totals: UsageTotals | undefined }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>
      <Typography color="text.secondary" variant="body2">
        {label}
      </Typography>
      <Typography variant="h5">{n(totals?.total ?? 0)}</Typography>
      <Typography color="text.secondary" variant="body2">
        {n(totals?.input ?? 0)} in · {n(totals?.output ?? 0)} out · {n(totals?.turns ?? 0)} turns
      </Typography>
    </Paper>
  );
}

// Settings → Usage: tokens used by the open chat and today, per provider, and
// per day for the last 30 days. Numbers only; no cost and no blocking.
export default function UsageSection() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getUsage(sessionFromHash(openChatHash()) ?? undefined)
      .then(setReport)
      .catch((e) => setError(e.message));
  }, []);

  const providers = report ? Object.entries(report.byProvider).sort((a, b) => b[1].total - a[1].total) : [];
  // Newest first, and days with no turns left out.
  const days = report ? report.byDay.filter((d) => d.totals.turns > 0).reverse() : [];

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Usage</Typography>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {!report && !error && <CircularProgress size={24} />}
      {report && (
        <>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <Headline label="This chat" totals={report.session} />
            <Headline label="Today" totals={report.today} />
          </Stack>
          {limitMessage(report.today.total, report.dailyTokenLimit) && (
            <Alert
              severity={limitLevel(report.today.total, report.dailyTokenLimit) === "over" ? "error" : "warning"}
              variant={limitLevel(report.today.total, report.dailyTokenLimit) === "over" ? "filled" : "standard"}
            >
              {limitMessage(report.today.total, report.dailyTokenLimit)}
            </Alert>
          )}
          {report.dailyTokenLimit > 0 && (
            <Typography color="text.secondary" variant="body2">
              Daily limit: {n(report.dailyTokenLimit)} tokens.
            </Typography>
          )}

          <Box>
            <Typography variant="h6">By provider</Typography>
            {providers.length === 0 ? (
              <Typography color="text.secondary">No turns recorded yet.</Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Provider</TableCell>
                    <TableCell align="right">Input</TableCell>
                    <TableCell align="right">Output</TableCell>
                    <TableCell align="right">Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {providers.map(([name, t]) => (
                    <TableRow key={name}>
                      <TableCell>{name}</TableCell>
                      <TableCell align="right">{n(t.input)}</TableCell>
                      <TableCell align="right">{n(t.output)}</TableCell>
                      <TableCell align="right">{n(t.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Box>

          <Box>
            <Typography variant="h6">By day (last 30 days)</Typography>
            {days.length === 0 ? (
              <Typography color="text.secondary">Nothing in the last 30 days.</Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Day</TableCell>
                    <TableCell align="right">Input</TableCell>
                    <TableCell align="right">Output</TableCell>
                    <TableCell align="right">Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {days.map(({ day, totals: t }) => (
                    <TableRow key={day}>
                      <TableCell>{day}</TableCell>
                      <TableCell align="right">{n(t.input)}</TableCell>
                      <TableCell align="right">{n(t.output)}</TableCell>
                      <TableCell align="right">{n(t.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Box>
        </>
      )}
    </Stack>
  );
}
