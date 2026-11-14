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
  // Sizes with no turns left out.
  const sizes = report ? report.bySize.filter((r) => r.totals.turns > 0) : [];

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
            <Typography variant="h6">By conversation size</Typography>
            <Typography color="text.secondary" variant="body2" sx={{ mb: 1 }}>
              How big the conversation was when each turn ended. Turns from before this was recorded are not counted. It shows where the tokens go, to judge the size at which a chat is compacted.
            </Typography>
            {sizes.length === 0 ? (
              <Typography color="text.secondary">No turns recorded with a size yet.</Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Conversation size</TableCell>
                    <TableCell align="right">Turns</TableCell>
                    <TableCell align="right">Fresh input</TableCell>
                    <TableCell align="right">Output</TableCell>
                    <TableCell align="right">Read from cache</TableCell>
                    <TableCell align="right">Written to cache</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sizes.map(({ label, totals: t }) => (
                    <TableRow key={label}>
                      <TableCell>{label}</TableCell>
                      <TableCell align="right">{n(t.turns)}</TableCell>
                      <TableCell align="right">{n(t.input)}</TableCell>
                      <TableCell align="right">{n(t.output)}</TableCell>
                      <TableCell align="right">{n(t.cacheRead)}</TableCell>
                      <TableCell align="right">{n(t.cacheWrite)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Box>

          <Box>
            <Typography variant="h6">Compactions</Typography>
            {report.compactions.count === 0 ? (
              <Typography color="text.secondary">No compactions recorded yet.</Typography>
            ) : (
              <>
                <Typography color="text.secondary" variant="body2" sx={{ mb: 1 }}>
                  {n(report.compactions.count)} compactions. Their summary requests used {n(report.compactions.summaryTokens.input)} fresh input,{" "}
                  {n(report.compactions.summaryTokens.output)} output, {n(report.compactions.summaryTokens.cacheRead)} read from cache and{" "}
                  {n(report.compactions.summaryTokens.cacheWrite)} written to cache.{" "}
                  {report.compactions.cacheReuse === null
                    ? "No cache numbers were reported for them."
                    : `${Math.round(report.compactions.cacheReuse * 100)}% of the summary requests was read from the cache (a healthy one reads nearly all of it)${report.compactions.lowReuse > 0 ? `; ${n(report.compactions.lowReuse)} read less than half, so the summary request stopped starting like the one before it` : ""}.`}{" "}
                  "Repeated calls" are tool calls made after a compaction that repeat one from before it: work the summary didn't carry forward. Often above 0 means compacting loses work; near 0 means a chat could be compacted earlier. "Compacted again soon" means the chat filled up again within 5 replies.
                </Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Chat size when compacted</TableCell>
                      <TableCell align="right">Compactions</TableCell>
                      <TableCell align="right">Replies after</TableCell>
                      <TableCell align="right">Repeated calls</TableCell>
                      <TableCell align="right">Compacted again soon</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {report.compactions.byBand
                      .filter((b) => b.count > 0)
                      .map((b) => (
                        <TableRow key={b.label}>
                          <TableCell>{b.label}</TableCell>
                          <TableCell align="right">{n(b.count)}</TableCell>
                          <TableCell align="right">{n(b.repliesAfter)}</TableCell>
                          <TableCell align="right">{n(b.forgottenRereads)}</TableCell>
                          <TableCell align="right">{n(b.soonAgain)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </>
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
