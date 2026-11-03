// How the server reaches its own /api. A plan run on the server uses the same
// client code as the page (src/api.ts), so it calls /api over http, and the
// proxy adds the connector's API key there. This turns the address the server
// is listening on into the origin that code should use.

import type { AddressInfo } from "node:net";

// null when the address is no use (not listening yet, or a socket path).
export function selfOrigin(address: AddressInfo | string | null | undefined): string | null {
  if (!address || typeof address === "string") return null;
  const host = address.address;
  // Listening on every interface: the loopback one reaches it too.
  if (host === "::" || host === "0.0.0.0" || host === "") return `http://127.0.0.1:${address.port}`;
  return `http://${address.family === "IPv6" || host.includes(":") ? `[${host}]` : host}:${address.port}`;
}
