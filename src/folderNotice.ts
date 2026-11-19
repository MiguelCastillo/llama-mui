// The notice under the chat when a folder of its environment is gone or can't
// be read. The server finds the problems (see server/folderProblems.ts); the
// page only says them. It names each stored path exactly, says nothing was sent
// or run and nothing was changed, and waits for the user.
import type { FolderProblem } from "./api";

const label = (p: FolderProblem) => (p.item === "workingDir" ? "working folder" : "attached folder");

export function folderNotice(problems: readonly FolderProblem[]): string | null {
  if (problems.length === 0) return null;
  const list = problems.map((p) => `the ${label(p)} ${p.path} (${p.why})`).join(", ");
  return (
    `This chat's ${list} can't be used. Nothing was sent or run, and the chat's folders were left unchanged; no other folder is used in its place. ` +
    `Pick another folder in the chat's folder settings, or restore the missing one and reopen the chat.`
  );
}
