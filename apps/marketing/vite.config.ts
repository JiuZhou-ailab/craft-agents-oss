// input: Marketing React app source
// output: Static landing-page build served from apps/marketing/dist
// pos: Vite configuration for the marketing website

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { embedReleaseNotes } from "./release-notes";

const appDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), { name: "release-notes", transformIndexHtml: (html) => embedReleaseNotes(html) }],
  root: appDir,
  base: "./",
  resolve: {
    alias: {
      "@storyflow/release-assets": resolve(appDir, "../../packages/shared/src/release-assets.ts"),
      "@": resolve(appDir, "./src"),
      react: resolve(appDir, "../../node_modules/react"),
      "react-dom": resolve(appDir, "../../node_modules/react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
  server: {
    port: 5176,
    open: false,
  },
  preview: {
    port: 4176,
  },
});
