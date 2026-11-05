// Which worktrees a session made: the ones its own create_worktree calls
// succeeded in making, read from its messages. A call's result starts with
// "Created a worktree of <repo> at <path> on a new branch <branch>, from <base>."
// when it worked (see createWorktree in worktree.ts); anything else is an error
// and made nothing. Pure: messages in, list out. A call with no result yet
// (the run stopped before it answered) made nothing known either.

export interface CreatedWorktree {
  name: string;
  path: string;
  branch: string;
  repo: string;
}

interface Msg {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: { id: string; name: string }[];
}

const CREATED = /^Created a worktree of (.+?) at (.+?) on a new branch (\S+?), from /;

export function createdWorktrees(messages: unknown): CreatedWorktree[] {
  if (!Array.isArray(messages)) return [];
  const msgs = messages as Msg[];
  const calls = new Set<string>();
  for (const m of msgs) {
    if (m?.role === "assistant" && Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) if (c?.name === "create_worktree" && typeof c.id === "string") calls.add(c.id);
    }
  }
  const found = new Map<string, CreatedWorktree>();
  for (const m of msgs) {
    if (m?.role !== "tool" || !m.toolCallId || !calls.has(m.toolCallId) || typeof m.content !== "string") continue;
    const hit = CREATED.exec(m.content);
    if (!hit) continue;
    const [, repo, wtPath, branch] = hit;
    found.set(wtPath, { name: wtPath.split("/").pop() ?? wtPath, path: wtPath, branch, repo });
  }
  return [...found.values()];
}
