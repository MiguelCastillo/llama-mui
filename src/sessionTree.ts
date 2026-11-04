// Turns the flat sessions list into the tree the sessions panel shows.
// Pure: no React, no network.
//
// parentId on a session is the id of its direct parent (any session, even a
// child). Today the panel shows ONE level: a session nested under a child is
// shown under the top-level session above it. That rule lives in topAncestor
// below and nowhere else. To allow deeper levels later, attach each row to its
// own parent instead of its top ancestor (and keep the cycle check); the
// SessionNode shape and the panel already handle any depth.
import type { Session, SessionSummary } from "./api.ts";
import { withSessionDefaults } from "./sessionDefaults.ts";

export type SessionNode = { session: SessionSummary; children: SessionNode[] };

// Newest first; the id keeps the order stable when two times are equal.
function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// The row a session is shown under, or the session itself when it is top-level.
// A row is top-level when it has no parent, its parent is missing from the
// list, or walking up from it comes back to it (a parentId cycle, a session
// that is its own parent included). Anything else is walked up to the first
// top-level row. This is the one-level rule.
function topAncestor(s: SessionSummary, byId: Map<string, SessionSummary>): SessionSummary {
  const parentOf = (x: SessionSummary) => (x.parentId ? byId.get(x.parentId) : undefined);

  // True when x has no parent in the list, or x sits on a parentId cycle.
  const isTop = (x: SessionSummary): boolean => {
    let cur = parentOf(x);
    if (!cur) return true; // no parent, or the parent is missing
    const seen = new Set<string>([x.id]);
    while (cur) {
      if (cur.id === x.id) return true; // back where we started: a cycle
      if (seen.has(cur.id)) return false; // a cycle above x that x is not part of
      seen.add(cur.id);
      cur = parentOf(cur);
    }
    return false; // the parent chain ends at a top row without returning to x
  };

  // Each step goes up one row and ends at a top row or at a cycle member, and
  // cycle members are top rows, so this always stops.
  let cur = s;
  while (!isTop(cur)) cur = parentOf(cur)!;
  return cur;
}

// Top-level sessions with their nested sessions, both newest first. A nested
// session has children: [] because of the one-level rule.
export function buildSessionTree(summaries: SessionSummary[]): SessionNode[] {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const nodes = new Map(summaries.map((s) => [s.id, { session: s, children: [] } as SessionNode]));
  const roots: SessionNode[] = [];
  for (const s of summaries) {
    const node = nodes.get(s.id)!;
    const top = topAncestor(s, byId);
    if (top.id === s.id) roots.push(node);
    else nodes.get(top.id)!.children.push(node);
  }
  const bySession = (a: SessionNode, b: SessionNode) => newestFirst(a.session, b.session);
  roots.sort(bySession);
  for (const r of roots) r.children.sort(bySession);
  return roots;
}

// An empty session nested under `parent`. It starts from the parent's model
// working directory and attachments but none of its messages, plan or todos.
// The attachments are copied, so changing one session's never changes the
// other's. Tools on/off is a global setting, not part of a session, so it
// needs no copying: the new session follows it like every other.
export function nestedSessionFrom(
  parent: Pick<Session, "id" | "model" | "attachments" | "workingDir">,
  id: string,
): Session {
  return withSessionDefaults({
    id,
    title: "New session",
    model: parent.model,
    messages: [],
    contextStart: 0,
    attachments: parent.attachments.map((a) => ({ ...a })),
    workingDir: parent.workingDir ?? null,
    usage: null,
    failed: null,
    plan: null,
    parentId: parent.id,
  });
}

// How many sessions are nested under this one, at any depth.
export function countNested(node: SessionNode): number {
  let n = 0;
  for (const c of node.children) n += 1 + countNested(c);
  return n;
}

// How many sessions the session `id` holds, for the delete question. It is the
// tree count (countNested on its node), but never fewer than the sessions that
// name it as their parent: with one level shown, a nested session's own
// children sit under the top row, so its node has none.
export function nestedHeldBy(summaries: SessionSummary[], id: string): number {
  const find = (nodes: SessionNode[]): SessionNode | undefined => {
    for (const n of nodes) {
      if (n.session.id === id) return n;
      const inner = find(n.children);
      if (inner) return inner;
    }
    return undefined;
  };
  const node = find(buildSessionTree(summaries));
  const direct = summaries.filter((s) => s.parentId === id && s.id !== id).length;
  return Math.max(node ? countNested(node) : 0, direct);
}
