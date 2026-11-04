import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("."),
  // Relative asset paths, so the build works under any GitHub Pages sub-path.
  base: "./",
  plugins: [
    // WebXR needs a secure context: a headset on the local network opens https://<laptop-ip>:5173
    // and accepts the self-signed certificate once.
    basicSsl(),
  ],
  resolve: {
    // Code written against the published package name runs from source.
    alias: { "@gramaziokohler/llhil-webxr": here("../../src/index.ts") },
  },
  server: { host: true, port: 5173 },
  preview: { host: true },
  // three.js alone is about 600 kB minified; one chunk is fine for a demo page.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
