import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/voice/",
  // Scripts loaded outside the hashed bundle (browser audio, worklets, workers) carry this in their URL:
  // a fixed tag let Safari keep serving a day-old audio engine from its cache (2026-09-19).
  define: { __BUILD_ID__: JSON.stringify(process.env.SIDEVOICE_BUILD_ID || Date.now().toString(36)) },
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
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
