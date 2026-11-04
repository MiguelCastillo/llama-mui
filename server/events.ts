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
//                                   run } (run is null when nothing runs). Then
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
import { sessionFolder } from "./sessionFile.ts";

export const HEARTBEAT_MS = 15_000;

// What the list-wide stream passes on. The rest (steps, the chat's changes,
// asks) is for the page that has the session open.
const GLOBAL_TYPES = new Set<hub.HubEventType>(["status", "saved", "removed", "thread"]);

type Send = (type: string, data: unknown) => void;

// Opens the stream and returns what writes to it. `onClose` runs once when the
// page goes away (at once if it already has).
function startStream(res: ServerResponse, heartbeatMs: number, onClose: () => void): Send {
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
    Connection: "keep-alive",
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
export async function eventRoutes({ res, parts, method }: Route, heartbeatMs = HEARTBEAT_MS): Promise<boolean> {
  const all = parts.length === 1 && parts[0] === "events";
  const one = parts.length === 3 && parts[0] === "sessions" && parts[2] === "events";
  if (!all && !one) return false;
  if (method !== "GET") throw new HttpError(405, "Events are read with GET");

  if (all) {
    // Listener and snapshot in the same step, so no run starts between them.
    const stop = hub.subscribe((e) => {
      if (GLOBAL_TYPES.has(e.type)) send(e.type, { id: e.id, ...e.data });
    });
    const send = startStream(res, heartbeatMs, stop);
    send("snapshot", { runs: hub.liveRuns() });
    return true;
  }

  const id = parts[1];
  sessionFolder(id); // a bad id is a 400, before any stream
  // Events that arrive between the snapshot being taken and it being sent wait here.
  let send: Send | undefined;
  const waiting: hub.HubEvent[] = [];
  const watching = await hub.watch(id, (e) => (send ? send(e.type, { id: e.id, ...e.data }) : waiting.push(e)));
  if (!watching) throw new HttpError(404, "No such session");
  const { session, revision, run, stop } = watching;
  send = startStream(res, heartbeatMs, stop);
  send("snapshot", { id, session, revision, run });
  for (const e of waiting.splice(0)) send(e.type, { id: e.id, ...e.data });
  return true;
}
