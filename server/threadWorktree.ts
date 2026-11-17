// A plan thread's own worktree, behind the "planWorktrees" experiment. Before
// the thread's first step, when the switch is on and the thread's working
// directory is set, the thread gets a copy of the project on its own branch
// (llama/plan-<first 8 characters of the thread's id>, from the repo's HEAD),
// in the thread's own session folder. The copy is recorded in the thread's
// messages like one the model made with create_worktree (see worktreeRecord),
// so the status and the report find it with no special case.
//
// Off, or no working directory: nothing changes and nothing is said. On but it
// couldn't be made (not a git repo, outside the home folder, git said no): the
// thread runs in the project folder as before, and a plain message in the
// thread says so. Never touches the project's files; only adds a branch and a
// worktree entry to its .git.

import { randomUUID } from "node:crypto";
import type { ChatMessage, Session } from "../src/api.ts";
import { worktreeRecord } from "./createdWorktrees.ts";
import { load } from "./store.ts";
import { makeWorktree } from "./worktree.ts";

export type MadeWorktree = { repo: string; path: string; branch: string; base: string };
export type MakeWorktree = (
  ctx: { chatId: string; workingDir: string | null; attachments: string[] },
  args: { repo: string; name: string },
) => Promise<MadeWorktree>;

export interface ThreadWorktree {
  // Messages to add to the thread before its first step; empty when nothing was said or made.
  messages: ChatMessage[];
  // The worktree, when one was made.
  worktree: MadeWorktree | null;
}

const NONE: ThreadWorktree = { messages: [], worktree: null };

// What a thread with its own copy of the project is told, added to the plan's
// context (which every step's instruction carries). Without a worktree the
// context is returned as it was.
export function withWorktreeRules(context: string | null | undefined, worktree: MadeWorktree | null): string | null {
  const base = typeof context === "string" && context.trim() ? context : null;
  if (!worktree) return context ?? null;
  const rules = [
    `This plan works in its own copy of the project: ${worktree.path} (branch ${worktree.branch}, made from ${worktree.base}).`,
    `Edit files only there, never in the main project folder (${worktree.repo}).`,
    "The copy holds only the files git tracks, so install the project's dependencies there before running tests.",
    "When the last step passes, commit your changes on that branch, with a short title line, a blank line, a plain description of what was wrong and what changed, a blank line, then a last line \"Files: \" followed by the files changed.",
  ].join("\n");
  return base ? `${base}\n\n${rules}` : rules;
}

export async function threadWorktree(
  thread: Pick<Session, "id" | "workingDir">,
  make: MakeWorktree = makeWorktree,
  newId: () => string = randomUUID,
): Promise<ThreadWorktree> {
  let on = false;
  try {
    on = (await load()).experiments.planWorktrees === true;
  } catch {
    on = false;
  }
  if (!on || typeof thread.workingDir !== "string" || !thread.workingDir) return NONE;
  try {
    const worktree = await make(
      { chatId: thread.id, workingDir: thread.workingDir, attachments: [] },
      { repo: thread.workingDir, name: `plan-${thread.id.slice(0, 8)}` },
    );
    return { messages: worktreeRecord(worktree, newId()) as ChatMessage[], worktree };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      messages: [
        {
          role: "assistant",
          content: `No separate copy of the project was made for this plan (${why}). It runs in the project folder, as it would with the switch off.`,
        },
      ],
      worktree: null,
    };
  }
}
