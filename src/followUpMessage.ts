import type { WorkEntry } from "./api";

// The message the WIP card's Follow up button sends to a chat. It describes the
// entry as the card sees it and asks the chat to find out what is really left,
// since the card often says "not merged" for work that is already in main
// (replayed or squashed commits leave the branch behind).
export function followUpMessage(entry: WorkEntry): string {
  const lines: string[] = [];
  const what = entry.kind === "loose" ? "uncommitted files" : entry.kind === "branch" ? "branch" : "worktree";
  lines.push(`Follow up on the work-in-progress card for ${what} "${entry.name}". It is not marked done. Please check what state it is really in.`);
  lines.push("");
  lines.push("What the card shows:");
  if (entry.branch) lines.push(`- Branch: ${entry.branch}`);
  if (entry.kind !== "branch") lines.push(`- Folder: ${entry.folder}`);
  if (entry.unmerged !== null) lines.push(`- Commits not in main: ${entry.unmerged}`);
  lines.push(`- Uncommitted files: ${entry.uncommitted}`);
  if (entry.lastCommitSubject) lines.push(`- Last commit: ${entry.lastCommitSubject}`);
  lines.push("");
  lines.push("Please:");
  if (entry.branch) {
    lines.push("1. Check whether this work is already in main. Don't rely on the commit count alone: the commits may have been replayed or squashed, so compare the changes themselves (for example with git cherry, or by diffing the branch against main).");
    lines.push("2. Check whether the branch and the worktree folder still exist.");
  } else {
    lines.push("1. Check whether these changes are already in main, or still only in the files.");
    lines.push("2. Check whether the files are still there.");
  }
  lines.push("3. List what has to be cleaned up for the card to be done (for example delete the branch, remove the worktree, commit or drop the uncommitted files), and say what is still unmerged, if anything.");
  if (entry.kind === "worktree" && entry.unmerged === 0 && entry.uncommitted > 0) {
    lines.push("");
    lines.push("The branch has no commits that are not in main, so the work itself is already in main. Only leftover uncommitted files remain. Even if they are harmless, they still need cleaning up: once I agree, commit or drop them, then remove the worktree.");
  }
  lines.push("");
  lines.push("Only look and report for now. Don't delete, remove or discard anything until I agree.");
  return lines.join("\n");
}
