// Server-sent events: how pages hear about runs and saves without asking.
// An event stream is an ordinary GET that stays open; the browser's
// EventSource reads it and, if the connection drops, opens it again by itself.
// Anything a page wants to do goes the other way as an ordinary request.
//
//   GET /api/events                 everything, for the sessions list. First
//                                   event `snapshot`: { runs: [{ id, run }] }, the
//                                   runs live now. Then, as they happen: `status`
//                                   (a run started, asked, ended: data.run
//                                   is its state, or null), `saved` (data.summary is
//                                   the list row, data.revision the new revision),
//                                   `removed`, `thread`. Never the chat itself.
//   GET /api/sessions/<id>/events   one session, for the page that has it open.
//                                   First event `snapshot`: { id, session, revision,
//                                   run, actions } (run is null when nothing runs;
//                                   actions is what the server lets the page offer,
//                                   see allowedActions.ts; `status` carries it too). Then
//                                   every event of that session: `status`, `step`,
//                                   `ask`, `session` (a patch, see sessionPatch.ts),
//                                   `saved`, `removed`, `thread`, `ack`.
//
// Every event is `event: <type>` and one line of JSON in `data:`, and each
// carries the session's id as `id` next to the rest. A comment line goes out
// every HEARTBEAT_MS so that nothing between here and the page closes a quiet
// connection. After a reconnect the page gets a fresh `snapshot`, which
// replaces whatever it had, so nothing missed while it was away matters.
//
// Nothing here can carry an API key: the server never gives a run one (the
// run calls the server's own /api and the proxy adds it), and the events are
// made of the run's state, patches of the session, and list rows.

import type { ServerResponse } from "node:http";
import { HttpError, type Route } from "./http.ts";
import * as hub from "./runHub.ts";
import { CHECK_IN_MS, holderOf, ownerAlive } from "./runRecord.ts";
import { sessionFolder, readSession } from "./sessionFile.ts";
import { sessionActions } from "./allowedActions.ts";

// A run's state with who holds the floor beside it, worked out here so the page
// never has to decide which server is "this one". Without a run: as it was.
const withHolder = <T extends { run?: any }>(data: T): T & { holder?: unknown } => {
  const holder = data.run ? holderOf(data.run) : null;
  return holder ? { ...data, holder } : data;
};

export const HEARTBEAT_MS = 15_000;

// What the page was told, boiled down to compare: the list and who holds the run.
const actionsKey = (run: any, actions: string[]) =>
  JSON.stringify([actions, run?.owner?.serverId ?? null, run?.owner?.port ?? null, run?.status ?? null]);

// What the list-wide stream passes on. The rest (steps, the chat's changes,
// asks) is for the page that has the session open.
const GLOBAL_TYPES = new Set<hub.HubEventType>(["status", "saved", "removed", "thread"]);

type Send = (type: string, data: unknown) => void;

// Opens the stream and returns what writes to it. `onClose` runs once when the
// page goes away (at once if it already has).
function startStream(res: ServerResponse, heartbeatMs: number, onClose: () => void): Send {
  // HTTP/2 forbids a Connection header (Node warns and drops it).
  const http2 = res.req?.httpVersion === "2.0";
  if (res.destroyed) {
    onClose();
    return () => {};
  }
  const write = (text: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(text);
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    ...(http2 ? {} : { Connection: "keep-alive" }),
    "X-Accel-Buffering": "no",
  });
  const timer = setInterval(() => write(": heartbeat\n\n"), heartbeatMs);
  res.once("close", () => {
    clearInterval(timer);
    onClose();
  });
  write("retry: 3000\n\n"); // how soon a dropped connection is tried again
  return (type, data) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Handles the two event streams; returns false for anything else.
export async function eventRoutes(
  { res, parts, method }: Route,
  heartbeatMs = HEARTBEAT_MS,
  pollMs = CHECK_IN_MS,
): Promise<boolean> {
  const all = parts.length === 1 && parts[0] === "events";
  const one = parts.length === 3 && parts[0] === "sessions" && parts[2] === "events";
  if (!all && !one) return false;
  if (method !== "GET") throw new HttpError(405, "Events are read with GET");

  if (all) {
    // Listener and snapshot in the same step, so no run starts between them.
    const stop = hub.subscribe((e) => {
      if (GLOBAL_TYPES.has(e.type)) send(e.type, { id: e.id, ...(e.type === "status" ? withHolder(e.data) : e.data) });
    });
    const send = startStream(res, heartbeatMs, stop);
    send("snapshot", { runs: hub.liveRuns().map((r) => withHolder(r)) });
    return true;
  }

  const id = parts[1];
  sessionFolder(id); // a bad id is a 400, before any stream
  // Events that arrive between the snapshot being taken and it being sent wait here.
  let send: Send | undefined;
  const waiting: hub.HubEvent[] = [];
  // A status event also carries `actions`, worked out from the session as saved
  // at that moment. Events go out one after another, in the order they came,
  // even though reading the session takes a moment.
  let line: Promise<void> = Promise.resolve();
  let told = ""; // what the page was last told about the actions (see the check below)
  const forward = (e: hub.HubEvent) => {
    line = line.then(async () => {
      if (e.type !== "status") return void send!(e.type, { id: e.id, ...e.data });
      const saved = await readSession(id).catch(() => null);
      // Unreadable session: an empty list, never a guess.
      const actions = saved ? sessionActions(saved, e.data.run as any) : [];
      told = actionsKey(e.data.run as any, actions);
      send!(e.type, { id: e.id, ...withHolder(e.data), actions });
    });
  };
  const watching = await hub.watch(id, (e) => (send ? forward(e) : waiting.push(e)));
  if (!watching) throw new HttpError(404, "No such session");
  const { session, revision, run, stop } = watching;
  let poll: ReturnType<typeof setInterval> | undefined;
  send = startStream(res, heartbeatMs, () => {
    if (poll) clearInterval(poll);
    stop();
  });
  const firstActions = sessionActions(session, run as any);
  send("snapshot", { id, session, revision, ...withHolder({ run }), actions: firstActions });
  for (const e of waiting.splice(0)) forward(e);

  // A run another server owns never reaches this server's hub, so nothing here
  // announces it ending, its owner dying (its check-ins just stop) or its steps
  // moving on. So while no run of this server is live in the session, the
  // session file is read every `pollMs` and, if what the page may offer (or who
  // holds the run) is not what it was last told, a `status` event with the new
  // list goes out. Status events from this server's own runs count as "told" too.
  told = actionsKey(run as any, firstActions);
  const sendTold = send;
  poll = setInterval(() => {
    line = line.then(async () => {
      if (hub.liveRun(id)) return; // this server's run: its own events tell the page
      const saved = await readSession(id).catch(() => null);
      if (!saved) return;
      const record = saved.run && typeof saved.run === "object" ? (saved.run as any) : null;
      const shown = record && ownerAlive(record) ? record : null;
      const actions = sessionActions(saved, record);
      const key = actionsKey(shown, actions);
      if (key === told) return;
      told = key;
      sendTold("status", { id, ...withHolder({ run: shown }), actions });
    });
  }, pollMs);
  poll.unref?.();
  return true;
}
