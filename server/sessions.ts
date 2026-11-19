// Saved sessions, one folder each in ~/.llama-mui/sessions/<id>/ with the
// session itself in session.json, so reloading the page, or coming back later,
// picks up where you left off. The files stay on this machine, outside the
// project, readable only by you. The folder's worktrees/ is the one part the
// model may change without asking (see inSessionWorktrees in disk.ts), so
// session.json can't be rewritten by it.

import { readdir, readFile } from "node:fs/promises";
import * as fsio from "./io/fs.ts";
import os from "node:os";
import path from "node:path";
import { sessionsDir } from "./disk.ts";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import * as hub from "./runHub.ts";
import { holderOf, ownerAlive } from "./runRecord.ts";
import { holderKind, sessionActions } from "./allowedActions.ts";
import { settleSession } from "./restart.ts";
import { descendantIds } from "../src/sessionTree.ts";
import { personaToSave } from "../src/persona.ts";
import { folderProblems } from "./folderProblems.ts";
import { ENVIRONMENT_ITEMS, ENVIRONMENT_KEYS, environmentChanges, environmentForSave, environmentOf, newChatEnvironment } from "./sessionEnvironment.ts";
import { resolveDefaultPersona } from "./personaChoice.ts";
import { loadPersonas } from "./personas.ts";
import { load } from "./store.ts";
import { log } from "./log.ts";
import { worktreeStatuses } from "./worktreeStatus.ts";
import { convertWorkingDir, deleteSession, draftOf, queueFieldsOf, readSession, revisionOf, sessionFolder, summaryOf, writeSession } from "./sessionFile.ts";

// Other modules (and tests) have always got these from here.
export { openTodoList, sessionFolder, summaryOf } from "./sessionFile.ts";

// Sessions used to be single files here, named <id>.json.
const OLD_CHATS_DIR = path.join(os.homedir(), ".llama-mui", "chats");

// Moves each old chat file into its session folder. A file is removed only
// after the copy is read back and matches; one that doesn't parse, whose id
// isn't its name, or whose session already has a session.json stays where it
// is, so nothing is lost.
async function migrateChats(): Promise<void> {
  const names = await readdir(OLD_CHATS_DIR).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const id = name.slice(0, -5);
    try {
      const old = JSON.parse(await readFile(path.join(OLD_CHATS_DIR, name), "utf8"));
      if (old.id !== id || (await readSession(id))) continue;
      await writeSession(id, old);
      // Reading converts a session with no workingDir (see convertWorkingDir),
      // so the copy is compared with the old file as it reads.
      if (JSON.stringify(await readSession(id)) === JSON.stringify(convertWorkingDir(old))) await fsio.remove(path.join(OLD_CHATS_DIR, name), undefined, { why: "sessions.migrate" });
    } catch (e) {
      console.warn(`Couldn't move ${name} to sessions: ${e}`);
    }
  }
  await fsio.removeEmptyDir(OLD_CHATS_DIR, { why: "sessions.migrate" }).catch(() => {}); // only works once it's empty
}

let migration: Promise<void> | undefined;

// Handles /api/sessions; returns false for anything else.
//   GET          → [summary], newest first; a summary is { id, title, updatedAt,
//                  modelName, userName, group, todos, parentId } (see summaryOf)
//   GET /<id>    → the saved session, with its `revision` (0 if it never had one)
//                  and `run` while a plan is running in it, on any server (a
//                  run whose owner is dead is settled as interrupted first)
//   GET /<id>/worktrees → [{ name, branch, uncommitted, unmerged, base }], one per
//                  worktree the session created (its create_worktree calls), read from git (see worktreeStatus.ts)
//   POST         { id, workingDir? } → creates an empty chat with its environment filled
//                  by the server (last used connection, its default model, the default
//                  persona; the folder as sent). Answers its summary plus `revision`,
//                  `environment` and `created`. A chat that exists is answered as it is
//                  (`created: false`) and nothing is written.
//   PUT /<id>    → saves it; the server sets createdAt, updatedAt and revision;
//                  answers with its summary plus the new `revision`. The queue of
//                  messages sent during a reply (`queue`, `queuePaused`) is the
//                  server's: a save keeps what the file has and ignores the body's. Send the
//                  `revision` the page loaded: if the file has moved on it answers
//                  409 { error, revision } and saves nothing. While a plan runs in
//                  the session, every PUT is a 409 (the run owns the session).
//   POST /<id>/environment { item, value } → the user's choice of one environment
//                  item (connectorId, model, workingDir, attachments, autoApprove);
//                  answers its summary plus `revision` and `environment`. A 409,
//                  nothing changed, while a run holds the chat or another server owns it.
//   PATCH /<id>  → updates only the name fields and the group, keeps updatedAt; answers with its
//                  summary plus `revision`. While a plan runs it goes through the
//                  run's live session.
//   DELETE /<id> → deletes its session.json, and its folder if nothing else is in
//                  it, together with every session nested under it (any depth);
//                  answers { id, deleted: [ids, the session last] }. A 409, with
//                  nothing deleted, while a plan runs in it or in any of them
// One line in the server's log per changed item, so a chat's environment can be
// traced afterwards: chat id, item, who asked, and (model, connection, folder
// names only) the old and new values. Never a key, prompt or reply.
function logEnvironment(chat: string, who: "user choice" | "refused save" | "save before the first message", changes: ReturnType<typeof environmentChanges>) {
  for (const c of changes) log("session.environment", { chat, who, ...c });
}

// What a brand-new chat starts with (see newChatEnvironment): used when one is
// created, and offered to the page for a chat that isn't saved yet.
async function offeredEnvironment(): Promise<Record<string, unknown>> {
  const names = await readdir(sessionsDir).catch(() => [] as string[]);
  const saved = (await Promise.all(names.map((n) => readSession(n).catch(() => null)))).filter((s) => s !== null);
  const store = await load();
  const { personas } = await loadPersonas();
  const persona = (await resolveDefaultPersona(store.defaultPersona, personas.map((p) => p.name))).name;
  return newChatEnvironment({ connectors: store.connectors, recent: saved.sort((a, b) => b.updatedAt - a.updatedAt), persona });
}

export async function sessionRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "sessions") return false;
  // Before the first request is answered, so a list never misses a session still in the old folder.
  await (migration ??= migrateChats());

  if (parts.length === 1 && method === "GET") {
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    const sessions = await Promise.all(names.map((n) => readSession(n).catch(() => null)));
    const list = sessions
      .filter((s) => s !== null)
      // A record's owner is judged by the same 20-second test as everywhere
      // else; nothing is written, a dead one is only shown as interrupted.
      .map((s) => {
        const live = hub.liveRun(s.id);
        const holder = holderOf(live ?? s.run);
        return {
          ...summaryOf(s),
          runStatus: live || ownerAlive(s.run) ? "running" : s.run ? "interrupted" : null,
          ...(holder ? { holder } : {}),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    sendJson(res, 200, list);
    return true;
  }
  // A new chat: the server fills its environment once (see newChatEnvironment).
  // A chat that already exists is answered as it is and nothing is written.
  if (parts.length === 1 && method === "POST") {
    const body = await readJson(req);
    const id = typeof body.id === "string" ? body.id : "";
    sessionFolder(id); // a bad id is a 400
    const answer = (session: any, revision: number, created: boolean) => ({ ...summaryOf(session), revision, environment: environmentOf(session), created });
    const existing = await readSession(id);
    if (existing) {
      sendJson(res, 200, answer(existing, revisionOf(existing), false));
      return true;
    }
    const environment = await offeredEnvironment();
    // The folder is the page's stopgap choice (see folderForNewChat), the one item it still supplies.
    const folder = ENVIRONMENT_ITEMS.find((i) => i.key === "workingDir")?.choose?.(body.workingDir);
    const { session, revision } = await hub.replace(id, (old) => {
      if (old) throw new HttpError(409, "This chat already exists, so its environment was left as it is.");
      const now = Date.now();
      return { id, title: "New session", messages: [], ...environment, ...(folder !== undefined ? { workingDir: folder } : {}), modelName: null, userName: null, group: null, createdAt: now, updatedAt: now };
    });
    sendJson(res, 200, answer(session, revision, true));
    return true;
  }
  // Where the session's work lives, computed from git each time (see worktreeStatus.ts).
  if (parts.length === 3 && parts[2] === "worktrees" && method === "GET") {
    const session = await readSession(parts[1]);
    sendJson(res, 200, session ? await worktreeStatuses(parts[1], session.messages) : []);
    return true;
  }
  // The user's explicit choice of one environment item (see sessionEnvironment.ts).
  if (parts.length === 3 && parts[2] === "environment" && method === "POST") {
    const id = parts[1];
    const body = await readJson(req);
    const item = ENVIRONMENT_ITEMS.find((i) => i.key === body.item);
    if (!item) throw new HttpError(400, `"${String(body.item)}" is not something a chat's environment has.`);
    if (!item.choose) throw new HttpError(400, `A chat's ${item.label} is fixed once the chat has started, so it can't be changed.`);
    const value = item.choose(body.value);
    if (value === undefined) throw new HttpError(400, `That isn't a valid ${item.label}, so nothing was changed.`);
    if (await readSession(id)) await settleSession(id);
    // The same list the page is given decides: no run, or no change.
    const check = (old: any, run: any) => {
      if (sessionActions(old, run).includes("changeEnvironment")) return;
      const holder = holderKind(run);
      const why =
        holder === "elsewhere"
          ? "Another server is running this chat"
          : holder === "unknown"
            ? "This server can't tell who is running this chat"
            : "A reply or plan is running in this chat";
      throw new HttpError(409, `${why}, so its ${item.label} was not changed. Change it when the run has ended; it applies from the next reply.`, {
        reason: holder === "elsewhere" ? "running elsewhere" : holder === "unknown" ? "owner unknown" : "run active",
      });
    };
    const saved = await readSession(id);
    if (!saved) throw new HttpError(404, "No such session");
    const live = hub.liveRun(id);
    if (live) check(saved, live); // before the save's own, shorter refusal
    let before: any;
    const { session, revision } = await hub.replace(id, (old) => {
      if (!old) throw new HttpError(404, "No such session");
      check(old, old.run);
      before = old;
      return { ...old, [item.key]: value };
    });
    logEnvironment(id, "user choice", environmentChanges(before, session));
    sendJson(res, 200, { ...summaryOf(session), revision, environment: environmentOf(session), folderProblems: await folderProblems(session) });
    return true;
  }
  if (parts.length !== 2) return false;
  const id = parts[1];

  if (method === "GET") {
    // A record whose owner is dead is settled now (marked interrupted, removed).
    // One whose owner is alive, here or on another server, is shown as the live run.
    if (await readSession(id)) await settleSession(id);
    const session = await readSession(id);
    if (!session) {
      // A chat not saved yet (a new one) has no run and no owner: the server
      // still says what it may offer, so the page never has to guess.
      // It also says what a new chat would start with, so the page shows the
      // server's choice of connection and model and never picks one itself.
      sendJson(res, 404, { error: "No such session", actions: sessionActions({}, null), environment: await offeredEnvironment() });
      return true;
    }
    const { run: recorded, ...saved } = session;
    const run = hub.liveRun(id) ?? (recorded && ownerAlive(recorded) ? recorded : null);
    const holder = run ? holderOf(run) : null;
    sendJson(res, 200, { ...saved, revision: revisionOf(session), ...(run ? { run } : {}), ...(holder ? { holder } : {}), actions: sessionActions(session, run), folderProblems: await folderProblems(session) });
    return true;
  }
  if (method === "PUT") {
    const body = await readJson(req);
    if (!Array.isArray(body.messages)) throw new HttpError(400, "messages must be a list");
    const sent = body.revision;
    if (sent !== undefined && !(Number.isInteger(sent) && sent >= 0)) throw new HttpError(400, "revision must be a whole number");
    let before: any;
    const { session, revision } = await hub.replace(
      id,
      (old) => {
        before = old;
        const now = Date.now();
        // The names are PATCH's, never a save's: a save from a copy made before
        // the model named the session wiped the name out. The title follows them.
        const modelName = old?.modelName ?? body.modelName ?? null;
        const userName = old ? (old.userName ?? null) : (body.userName ?? null);
        const group = old ? (old.group ?? null) : (body.group ?? null); // a PATCH's too
        const title = String(userName ?? modelName ?? body.title ?? "New session").slice(0, 100);
        // The chat's connection is kept when it is text and dropped otherwise.
        // `folderProblems` is looked up on every read (never stored), so a copy the page sends back is dropped.
        const { queue: _queue, queuePaused: _paused, folderProblems: _problems, ...restWithEnvironment } = body;
        // Every environment item except the persona: a started chat keeps its
        // stored ones and a save without a connection no longer drops it.
        const environment = environmentForSave(old, body);
        const rest = Object.fromEntries(Object.entries(restWithEnvironment).filter(([k]) => !ENVIRONMENT_KEYS.includes(k) || k === "persona"));
        // The queue is the server's, like the names: a save from a copy made
        // before a message was queued or sent must not bring it back or lose it.
        // A new session has none, whatever the body says.
        const queue = queueFieldsOf(old);
        // The persona's name is fixed once the chat has started: a save can
        // choose it before then, never change it after (see personaToSave).
        const { persona: _sentPersona, draft: sentDraft, ...others } = rest;
        const persona = personaToSave(old, _sentPersona);
        // The unsent text, kept only while it has text; a blank one is dropped.
        const draft = draftOf(sentDraft);
        return {
          ...others,
          ...(draft ? { draft } : {}),
          ...environment,
          ...(persona ? { persona } : {}),
          id,
          title,
          modelName,
          userName,
          group,
          ...queue,
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
        };
      },
      sent,
    );
    if (before) {
      // What the page sent and the chat kept instead was refused; the rest is a
      // chat that had not started taking what was sent.
      const refused = environmentChanges(session, body).filter((c) => c.item !== "persona" || before.persona !== undefined);
      logEnvironment(id, "refused save", refused);
      logEnvironment(id, "save before the first message", environmentChanges(before, session).filter((c) => c.item !== "persona"));
    }
    sendJson(res, 200, { ...summaryOf(session), revision });
    return true;
  }
  if (method === "PATCH") {
    const body = await readJson(req);
    const { session, revision } = await hub.edit(id, (s) => {
      if (body.title !== undefined) s.title = String(body.title).slice(0, 100);
      if (body.modelName !== undefined) s.modelName = body.modelName;
      if (body.userName !== undefined) s.userName = body.userName;
      // The group a top-level session is listed under; empty or null: none.
      if (body.group !== undefined) s.group = body.group === null ? null : String(body.group).trim().slice(0, 60) || null;
    });
    sendJson(res, 200, { ...summaryOf(session), revision });
    return true;
  }
  if (method === "DELETE") {
    sessionFolder(id); // a bad id is a 400
    // The session goes with every session nested under it, at any depth. A run
    // in any of them refuses the whole delete before anything is removed, so a
    // family is never left half deleted. A worktree in a folder is still kept
    // (see deleteSession).
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    const rows = (await Promise.all(names.map((n) => readSession(n).catch(() => null)))).filter((s) => s !== null).map(summaryOf);
    const nested = descendantIds(rows, id);
    if ([id, ...nested].some((s) => hub.liveRun(s))) {
      throw new HttpError(
        409,
        nested.length === 0
          ? "A plan is running in this session. Stop it first."
          : "A plan is running in this session or in one nested under it. Stop it first.",
        { reason: "run active" },
      );
    }
    // The deepest first, so a parent is never left pointing at nothing.
    const deleted = [...nested.reverse(), id];
    for (const gone of deleted) await hub.remove(gone, () => deleteSession(gone), deleted);
    sendJson(res, 200, { id, deleted });
    return true;
  }
  return false;
}
