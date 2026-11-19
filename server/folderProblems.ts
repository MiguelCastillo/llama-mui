// Folders of a chat's environment that are gone or can't be read. The server
// looks (the page never does) and says so with the session's answer; commands
// refuse to run while one is missing. Nothing is ever substituted for it: the
// user picks another folder through the explicit environment request.

import { access, constants, stat } from "node:fs/promises";

export interface FolderProblem {
  // Which environment item holds the folder.
  item: "workingDir" | "attachments";
  // The stored path, exactly as saved.
  path: string;
  why: "missing" | "not a folder" | "can't be read";
}

// `mustBeFolder`: false for an attachment whose kind isn't known (a file is
// fine there; it only has to exist).
async function problemWith(folder: string, mustBeFolder: boolean): Promise<FolderProblem["why"] | null> {
  try {
    const isFolder = (await stat(folder)).isDirectory();
    if (mustBeFolder && !isFolder) return "not a folder";
    await access(folder, isFolder ? constants.R_OK | constants.X_OK : constants.R_OK);
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR" ? "missing" : "can't be read";
  }
}

// The working folder and every attached folder of a session. An attachment is
// a path string (as a tool call has it) or { path, kind } (as a session has it);
// a file only has to exist.
export async function folderProblems(s: { workingDir?: unknown; attachments?: unknown }): Promise<FolderProblem[]> {
  const found: { item: FolderProblem["item"]; path: string; mustBeFolder: boolean }[] = [];
  if (typeof s.workingDir === "string" && s.workingDir) found.push({ item: "workingDir", path: s.workingDir, mustBeFolder: true });
  if (Array.isArray(s.attachments)) {
    for (const a of s.attachments) {
      if (typeof a === "string") found.push({ item: "attachments", path: a, mustBeFolder: false });
      else if (a && typeof a === "object" && typeof a.path === "string") found.push({ item: "attachments", path: a.path, mustBeFolder: a.kind === "folder" });
    }
  }
  const out: FolderProblem[] = [];
  for (const f of found) {
    const why = await problemWith(f.path, f.mustBeFolder);
    if (why) out.push({ item: f.item, path: f.path, why });
  }
  return out;
}

// The sentence a command is refused with.
export function folderProblemMessage(problems: FolderProblem[]): string {
  const list = problems.map((p) => `${p.item === "workingDir" ? "working folder" : "attached folder"} ${p.path} (${p.why})`).join("; ");
  return `Nothing was run: ${list}. The chat keeps that folder and no other folder is used in its place. Ask the user to pick another folder (or restore this one) in the chat's folder settings.`;
}
