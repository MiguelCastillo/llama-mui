import { Box, Button, Drawer, Link, Typography } from "@mui/material";
import type { MergeAttemptState, WorkEntry } from "./api";
import { PANEL_VARIANTS } from "./Panel";
import { sessionHash } from "./sessionRoute";
import { ago } from "./SessionsPanel";

const WIDTH = 300;
// How many file names an entry lists before "and N more".
const FILES_SHOWN = 5;

// What state the work is in, in plain words.
export function workState(e: WorkEntry): string {
  if (e.kind === "loose") return "Has uncommitted files";
  if (e.merged) return "Merged";
  if (e.uncommitted > 0) return "Has uncommitted files";
  if (e.kind === "worktree") return "Finished and committed";
  return "Needs a decision";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// How big the set of changes is: "3 files" (or "No files changed").
export function workSize(e: WorkEntry): string {
  return e.filesTotal === 0 ? "No files changed" : plural(e.filesTotal, "file");
}

// The groups, in the order shown. Each takes the entries of one kind.
const GROUPS: { kind: WorkEntry["kind"]; title: string }[] = [
  { kind: "worktree", title: "Thread branches" },
  { kind: "branch", title: "Older branches" },
  { kind: "loose", title: "Loose files" },
];

// What the panel needs to merge: the current attempt and what can be done to it.
export interface MergeUi {
  attempt: MergeAttemptState | null;
  error: string | null;
  start(branch: string): void;
  approve(): void;
  discard(): void;
  dismiss(): void;
}

// An attempt that still holds a worktree or is running: no other merge may start.
const HOLDS = ["replaying", "checking", "ready", "failed"];

// Can this entry be merged now? Not loose files, not merged work, not work with
// uncommitted files, and not while another attempt is open.
export function canMerge(e: WorkEntry, merge?: MergeUi): boolean {
  if (!merge || e.kind === "loose" || e.merged || !e.unmerged || e.uncommitted > 0 || !e.branch) return false;
  return !(merge.attempt && HOLDS.includes(merge.attempt.state));
}

function MergeProgress({ a, merge }: { a: MergeAttemptState; merge: MergeUi }) {
  const note = { fontSize: "0.75rem", mt: 0.5, overflowWrap: "anywhere" as const };
  if (a.state === "replaying") return <Typography sx={note}>Replaying {plural(a.replayed ?? 0, "commit")}…</Typography>;
  if (a.state === "checking") return <Typography sx={note}>Running {a.check ?? "checks"}…</Typography>;
  if (a.state === "merged") return <Typography sx={note}>Merged</Typography>;
  if (a.state === "conflict") {
    return (
      <Box sx={note}>
        <div>These files clash with the main branch, so nothing was merged:</div>
        <div>{(a.files ?? []).join(", ")}</div>
        <Button size="small" onClick={merge.dismiss}>Close</Button>
      </Box>
    );
  }
  if (a.state === "error") {
    return (
      <Box sx={note}>
        <div>{a.message ?? "The merge could not be done."}</div>
        <Button size="small" onClick={merge.dismiss}>Close</Button>
      </Box>
    );
  }
  // ready or failed: show each check.
  const passed = a.checks.length > 0 && a.checks.every((c) => c.ok) && a.state === "ready";
  return (
    <Box sx={note}>
      {a.checks.map((c) => (
        <Box key={c.name} data-merge-check={c.name}>
          <div>
            {c.name}: {c.ok ? "passed" : "failed"}
          </div>
          {!c.ok && c.output && (
            <Box component="pre" sx={{ m: 0, fontSize: "0.7rem", whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }}>
              {c.output}
            </Box>
          )}
        </Box>
      ))}
      {a.message && a.state === "failed" && <div>{a.message}</div>}
      <Box sx={{ display: "flex", gap: 1, mt: 0.5 }}>
        {passed && (
          <Button size="small" variant="contained" onClick={merge.approve}>
            Approve
          </Button>
        )}
        <Button size="small" onClick={merge.discard}>
          Discard
        </Button>
      </Box>
    </Box>
  );
}

function Entry({ entry: e, merge }: { entry: WorkEntry; merge?: MergeUi }) {
  const shown = e.files.slice(0, FILES_SHOWN);
  const more = e.filesTotal - shown.length;
  const mine = merge?.attempt && merge.attempt.branch === e.branch && merge.attempt.state !== "discarded" ? merge.attempt : null;
  return (
    // The look of a quiet panel (Panel.tsx), without its hover toolbar.
    <Box sx={PANEL_VARIANTS.actionDone}>
      <Box sx={{ width: "100%", minWidth: 0 }} data-work-entry={e.kind}>
        <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
          {e.purpose ?? "No description"}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: "anywhere" }}>
          {e.kind === "loose" ? "In the main folder" : (e.branch ?? e.name)}
        </Typography>
        <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
          {workState(e)}
          {e.unmerged ? ` · ${plural(e.unmerged, "commit")}` : ""}
          {e.uncommitted > 0 && e.kind !== "loose" ? ` · ${e.uncommitted} uncommitted` : ""}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div">
          {workSize(e)}
          {/* The server sends git's commit time in seconds; ago wants milliseconds. */}
          {e.lastCommitTime ? ` · ${ago(e.lastCommitTime * 1000)}` : ""}
        </Typography>
        {shown.length > 0 && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
            {shown.join(", ")}
            {more > 0 ? ` and ${more} more` : ""}
          </Typography>
        )}
        {e.source && (
          <Link href={sessionHash(e.source)} variant="caption" underline="hover" sx={{ display: "inline-block", mt: 0.5 }}>
            Open chat
          </Link>
        )}
        {merge && mine && <MergeProgress a={mine} merge={merge} />}
        {merge && !mine && canMerge(e, merge) && (
          <Box sx={{ mt: 0.5 }}>
            <Button size="small" variant="outlined" onClick={() => merge.start(e.branch as string)}>
              Merge
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// Work started but not yet in the main branch of this project: what each set
// of changes is for, what state it is in, and how big it is. Read-only.
// Beside the chat on wide screens; on phones it slides in over it.
export default function WorkPanel({
  entries,
  open,
  narrow,
  onClose,
  merge,
}: {
  merge?: MergeUi;
  entries: WorkEntry[];
  open: boolean;
  narrow: boolean;
  onClose: () => void;
}) {
  const list = (
    <Box
      sx={{
        width: narrow ? "75vw" : WIDTH,
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Typography variant="subtitle2" sx={{ pl: 2, pr: 1, pt: 1.5, pb: 0.5 }}>
        Work in progress
      </Typography>
      {merge?.error && (
        <Typography variant="caption" color="error" component="div" sx={{ px: 2, pb: 0.5, overflowWrap: "anywhere" }}>
          {merge.error}{" "}
          <Link component="button" variant="caption" onClick={merge.dismiss}>
            Close
          </Link>
        </Typography>
      )}
      {entries.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2 }}>
          Nothing is in progress.
        </Typography>
      ) : (
        <Box sx={{ overflowY: "auto", flexGrow: 1, px: 1, pb: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {GROUPS.map((g) => {
            const items = entries.filter((e) => e.kind === g.kind);
            if (items.length === 0) return null;
            return (
              <Box key={g.kind} component="section" aria-label={g.title} sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, px: 0.5 }}>
                  {g.title} ({items.length})
                </Typography>
                {items.map((e) => (
                  <Entry key={`${e.kind}:${e.folder}:${e.branch ?? e.name}`} entry={e} merge={merge} />
                ))}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
  if (narrow) {
    return (
      <Drawer anchor="right" open={open} onClose={onClose}>
        {list}
      </Drawer>
    );
  }
  if (!open) return null;
  return (
    <Box sx={{ flexShrink: 0, height: "100dvh", borderLeft: 1, borderColor: "divider", width: WIDTH }}>{list}</Box>
  );
}
