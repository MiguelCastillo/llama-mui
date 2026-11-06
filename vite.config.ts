import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { api } from "./server/plugin.ts";

export default defineConfig({
  plugins: [react(), api()],
  server: {
    // Dev is on 5174; the built app (npm run prod) has 5173. strictPort so a
    // busy port is an error, not a quiet move to another one.
    port: 5174,
    strictPort: true,
  },
});
