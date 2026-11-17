import { Box, Drawer, Link, Typography } from "@mui/material";
import type { WorkEntry } from "./api";
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

function Entry({ entry: e }: { entry: WorkEntry }) {
  const shown = e.files.slice(0, FILES_SHOWN);
  const more = e.filesTotal - shown.length;
  return (
    // The look of a quiet panel (Panel.tsx), without its hover toolbar: this one is read-only.
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
}: {
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
                  <Entry key={`${e.kind}:${e.folder}:${e.branch ?? e.name}`} entry={e} />
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
