import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config — frontend binds to loopback only.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 5174,
  },
  build: {
    sourcemap: true,
    target: "es2020",
  },
});
