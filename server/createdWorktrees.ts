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

// What create_worktree answers when it worked. The one place the text is
// written, so what is read back below always matches it.
export function createdText(w: { repo: string; path: string; branch: string; base: string }): string {
  return (
    `Created a worktree of ${w.repo} at ${w.path} on a new branch ${w.branch}, from ${w.base}. ` +
    "It holds only the files git tracks, so install dependencies before running tests. " +
    `Use ${w.path} as cwd for run_command; you can change files there without asking.`
  );
}

// The two messages that record a worktree the server made for a session (a
// plan thread's own, see threadWorktree.ts) as if the model had called
// create_worktree: the call, and its answer. createdWorktrees finds it like
// any other, so the worktree lines and the status read it with no special case.
export function worktreeRecord(w: { repo: string; path: string; branch: string; base: string }, callId: string) {
  const args = JSON.stringify({ repo: w.repo, name: w.path.split("/").pop(), base: w.base });
  return [
    { role: "assistant" as const, content: "", toolCalls: [{ id: callId, name: "create_worktree", arguments: args, started: true }] },
    { role: "tool" as const, content: createdText(w), toolCallId: callId },
  ];
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
