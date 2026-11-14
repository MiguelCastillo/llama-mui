import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { logging } from "./server/lifecycle.ts";
import { api } from "./server/plugin.ts";
import { selfSignedCert } from "./server/cert.ts";

export default defineConfig({
  plugins: [react(), api(), logging()],
  server: {
    // Dev is on 5174; the built app (npm run prod) has 5173. strictPort so a
    // busy port is an error, not a quiet move to another one. host: true binds
    // to all interfaces so the LAN IP is reachable from mobile. https is
    // made at startup (server/cert.ts) so no cert files are needed.
    port: 5174,
    strictPort: true,
    host: true,
    https: selfSignedCert(),
  },
});
