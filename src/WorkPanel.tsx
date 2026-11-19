import { Box, Button, Chip, Typography } from "@mui/material";
import type { WorkEntry } from "./api";
import { PANEL_VARIANTS } from "./Panel";
import { sessionHash } from "./sessionRoute";
import { ago } from "./SessionsPanel";

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

// The chip's look for each state, chosen from the state's wording.
function stateChip(state: string): { color: "warning" | "success" | "default"; variant: "filled" | "outlined" } {
  switch (state) {
    case "Needs a decision":
      return { color: "warning", variant: "filled" };
    case "Has uncommitted files":
      return { color: "warning", variant: "outlined" };
    case "Finished and committed":
      return { color: "success", variant: "filled" };
    default:
      return { color: "default", variant: "filled" };
  }
}

// How soon an entry needs a look: lower comes first, merged entries last.
function attentionRank(e: WorkEntry): number {
  switch (workState(e)) {
    case "Needs a decision":
      return 0;
    case "Has uncommitted files":
      return 1;
    case "Finished and committed":
      return 2;
    default:
      return 3;
  }
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

function Entry({ entry: e, onFollowUp }: { entry: WorkEntry; onFollowUp?: (entry: WorkEntry) => void }) {
  const shown = e.files.slice(0, FILES_SHOWN);
  const more = e.filesTotal - shown.length;
  return (
    // The look of a quiet panel (Panel.tsx), without its hover toolbar.
    <Box sx={{ ...PANEL_VARIANTS.actionDone, opacity: e.merged ? 0.6 : 1 }}>
      <Box sx={{ width: "100%", minWidth: 0 }} data-work-entry={e.kind}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
            overflowWrap: "anywhere",
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {e.purpose ?? "No description"}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: "anywhere" }}>
          {e.kind === "loose" ? "In the main folder" : (e.branch ?? e.name)}
        </Typography>
        <Box sx={{ mt: 0.5, display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 1 }}>
          <Chip size="small" label={workState(e)} {...stateChip(workState(e))} />
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            {[
              e.unmerged ? plural(e.unmerged, "commit") : "",
              // A merged entry's leftover counts would contradict its state.
              e.uncommitted > 0 && e.kind !== "loose" && !e.merged ? `${e.uncommitted} uncommitted` : "",
              e.merged && e.filesTotal === 0 ? "" : workSize(e),
              // The server sends git's commit time in seconds; ago wants milliseconds.
              e.lastCommitTime ? ago(e.lastCommitTime * 1000) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </Typography>
        </Box>
        {shown.length > 0 && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
            {shown.join(", ")}
            {more > 0 ? ` and ${more} more` : ""}
          </Typography>
        )}
        {(e.source || (onFollowUp && !e.merged)) && (
          <Box sx={{ mt: 0.5, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}>
            {e.source && (
              <Button size="small" component="a" href={sessionHash(e.source)}>
                Open chat
              </Button>
            )}
            {onFollowUp && !e.merged && (
              <Button size="small" variant="outlined" onClick={() => onFollowUp(e)}>
                Follow up
              </Button>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

// Work started but not yet in the main branch of this project: what each set
// of changes is for, what state it is in, and how big it is. Follow up asks the chat about it.
// Rendered inside the sessions panel, under a collapsible section header.
export default function WorkPanel({
  entries,
  onFollowUp,
}: {
  entries: WorkEntry[];
  onFollowUp?: (entry: WorkEntry) => void;
}) {
  return (
    <Box sx={{ width: "100%" }}>
      {entries.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2 }}>
          Nothing is in progress.
        </Typography>
      ) : (
        <Box sx={{ overflowY: "auto", flexGrow: 1, px: 1, pb: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {GROUPS.map((g) => {
            // Array.sort is stable, so equal ranks keep the server's order.
            const items = entries.filter((e) => e.kind === g.kind).sort((a, b) => attentionRank(a) - attentionRank(b));
            if (items.length === 0) return null;
            return (
              <Box key={g.kind} component="section" aria-label={g.title} sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, px: 0.5 }}>
                  {g.title} ({items.length})
                </Typography>
                {items.map((e) => (
                  <Entry key={`${e.kind}:${e.folder}:${e.branch ?? e.name}`} entry={e} onFollowUp={onFollowUp} />
                ))}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
