// Whether devices other than this computer may connect at all (Settings →
// Phone, "Let other devices connect"). The servers listen on every network
// interface, so this is decided per connection: a connection from anywhere but
// this computer is closed the moment it arrives, before a byte is read, unless
// the setting is on. Turning it off also closes the connections from other
// devices that are open. Nothing is rebound, so replies and runs that are going
// are not touched. Pairing (phones.ts) is what lets a device in once it is on.

import type { Http2SecureServer, ServerHttp2Session } from "node:http2";
import type { Server, Socket } from "node:net";
import { load } from "./store.ts";

export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

type Closable = { destroy(): unknown; once(event: "close", listener: () => void): unknown };

let allowed = false;
const outside = new Set<Closable>();

export const otherDevicesAllowed = () => allowed;

export function setOtherDevices(on: boolean) {
  allowed = on;
  if (!on) for (const socket of outside) socket.destroy();
}

// Reads the saved setting. Until it has, other devices are kept out.
export async function loadOtherDevices() {
  setOtherDevices((await load()).otherDevices === true);
}

// Put on every server that listens beyond this computer (main.ts and the Vite
// dev server, through whenServing in plugin.ts).
export function guardNetwork(server: Server | Http2SecureServer) {
  const check = (conn: Closable, address: string | undefined) => {
    if (LOOPBACK.has(address ?? "")) return;
    if (!allowed) return void conn.destroy();
    outside.add(conn);
    conn.once("close", () => outside.delete(conn));
  };
  server.on("connection", (socket: Socket) => check(socket, socket.remoteAddress));
  // An HTTP/2 connection is a session. Its socket is reached through the
  // session (a stand-in that can be read but not closed), so it is checked
  // again here and closed by closing the session.
  server.on("session", (session: ServerHttp2Session) => check(session, session.socket.remoteAddress));
}
