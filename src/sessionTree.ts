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
// and connection, working directory and attachments but none of its messages, plan or todos.
// The attachments are copied, so changing one session's never changes the
// other's. Tools on/off is a global setting, not part of a session, so it
// needs no copying: the new session follows it like every other.
export function nestedSessionFrom(
  parent: Pick<Session, "id" | "model" | "connectorId" | "attachments" | "workingDir">,
  id: string,
): Session {
  return withSessionDefaults({
    id,
    title: "New session",
    model: parent.model,
    ...(parent.connectorId ? { connectorId: parent.connectorId } : {}),
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

// Every session nested under `id`, at any depth: the ones that name it as their
// parent, the ones that name those, and so on. Parents come before their
// children. It never includes `id`, and a parentId cycle is walked once, so it
// always stops. Deleting a session deletes exactly these with it, on the server
// (see the DELETE route in server/sessions.ts) and in the question the page asks.
export function descendantIds(rows: { id: string; parentId?: string | null }[], id: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>([id]);
  for (let i = -1; i < found.length; i++) {
    const parent = i < 0 ? id : found[i];
    for (const r of rows) {
      if (r.parentId === parent && !seen.has(r.id)) {
        seen.add(r.id);
        found.push(r.id);
      }
    }
  }
  return found;
}

// The sessions whose delete button is off: every session in a family (a
// top-level session and everything shown under it) while any session in that
// family has a run in progress. A run owns its session, and deleting a parent
// takes its nested sessions with it, so the whole family waits until it ends.
export function deleteLockedIds(tree: SessionNode[], inProgress: ReadonlySet<string>): Set<string> {
  const familyOf = (n: SessionNode): string[] => [n.session.id, ...n.children.flatMap(familyOf)];
  const locked = new Set<string>();
  for (const root of tree) {
    const family = familyOf(root);
    if (family.some((id) => inProgress.has(id))) for (const id of family) locked.add(id);
  }
  return locked;
}

// How many sessions the session `id` holds, for the delete question.
export const nestedHeldBy = (summaries: SessionSummary[], id: string): number => descendantIds(summaries, id).length;

// The tree narrowed to what a search matches. A top-level session that matches
// keeps everything nested under it; one that doesn't stays only if something
// nested under it matches, and then shows just those.
export function filterTree(tree: SessionNode[], matches: (s: SessionSummary) => boolean): SessionNode[] {
  const out: SessionNode[] = [];
  for (const node of tree) {
    if (matches(node.session)) {
      out.push(node);
      continue;
    }
    const children = node.children.filter((c) => matches(c.session));
    if (children.length > 0) out.push({ session: node.session, children });
  }
  return out;
}

// A named set of top-level sessions, as the panel lists them. `name` is null
// for the sessions in no group.
export type SessionGroup = { name: string | null; nodes: SessionNode[] };

// The tree split by each top-level session's group (a nested session goes with
// its parent). The named groups come first, A to Z, then the sessions in no
// group; order inside each is the tree's. A group with no sessions isn't listed.
export function groupTree(tree: SessionNode[]): SessionGroup[] {
  const named = new Map<string, SessionNode[]>();
  const loose: SessionNode[] = [];
  for (const node of tree) {
    const name = node.session.group;
    if (!name) loose.push(node);
    else named.set(name, [...(named.get(name) ?? []), node]);
  }
  const groups: SessionGroup[] = [...named.keys()].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, nodes: named.get(name)! }));
  if (loose.length > 0) groups.push({ name: null, nodes: loose });
  return groups;
}

// Every group name in use, A to Z, for the "move to group" menu.
export function groupNames(summaries: SessionSummary[]): string[] {
  return [...new Set(summaries.filter((s) => !s.parentId && s.group).map((s) => s.group!))].sort((a, b) => a.localeCompare(b));
}
