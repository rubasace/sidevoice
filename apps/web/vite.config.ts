import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { writeFileSync, mkdirSync } from "node:fs";

const buildId = process.env.SIDEVOICE_BUILD_ID || Date.now().toString(36);

export default defineConfig({
  base: "/voice/",
  // Scripts loaded outside the hashed bundle (browser audio, worklets, workers) carry this in their URL:
  // a fixed tag let Safari keep serving a day-old audio engine from its cache (2026-09-19).
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), {
    name: "sidevoice-build-id",
    // Only a real build writes it: a test run through this same config used to overwrite it with an id no
    // bundle carries, and every page then read as stale against the room (2026-09-26).
    apply: "build",
    // The room reads this to tell a page which build it is serving, so a stale tab can say so.
    closeBundle() { mkdirSync("dist", { recursive: true }); writeFileSync("dist/build-id.json", JSON.stringify({ build_id: buildId }) + "\n"); },
  }],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // Reachable from a phone through the tunnel, not just from localhost: `npm run dev -w @sidevoice/web`
    // then expose this port. The websocket that pushes the updates has to be told it arrives over TLS on
    // 443, or the page loads and then never hears about a change — which looks exactly like no hot reload.
    host: true,
    allowedHosts: true,
    // The page may be served by the room (VOICE_WEB_DEV_SERVER) while this server only feeds it modules,
    // so the hot-reload socket is told exactly where to find itself rather than inferring it from the page.
    hmr: process.env.SIDEVOICE_HMR_HOST
      ? { host: process.env.SIDEVOICE_HMR_HOST, clientPort: 443, protocol: "wss" }
      : { clientPort: 443, protocol: "wss" },
    proxy: {
      "/api": { target: "http://127.0.0.1:8767", ws: true },
      "/voice-browser": { target: "http://127.0.0.1:8767" },
      "/voice/mic_capture.js": { target: "http://127.0.0.1:8767" }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"]
  }
});
