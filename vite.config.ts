import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { logging } from "./server/lifecycle.ts";
import { api } from "./server/plugin.ts";
import { selfSignedCert } from "./server/cert.ts";

export default defineConfig({
  plugins: [react(), api(), logging()],
  server: {
    // Dev is https on every interface at HTTPS_PORT (default 5175; the
    // microphone and phones need it; other devices are let in only when
    // Settings → Phone allows it, server/lan.ts), and the same app is plain http
    // on this computer only at HTTP_PORT (default 5174, set in api() in
    // server/plugin.ts), which inspect_page opens without a certificate
    // warning. The built app (npm run prod) is the same pair on 5173 and 5172.
    // strictPort so a busy port is an error, not a quiet move to another one.
    // The certificate is made at startup (server/cert.ts) so no cert files are
    // needed.
    port: Number(process.env.HTTPS_PORT ?? 5175),
    strictPort: true,
    host: true,
    https: selfSignedCert(),
  },
});
