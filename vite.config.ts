import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { api } from "./server/plugin.ts";

export default defineConfig({
  plugins: [react(), api()],
  server: {
    port: 5173,
  },
});
