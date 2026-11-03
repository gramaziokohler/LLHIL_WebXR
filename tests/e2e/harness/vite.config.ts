import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export default defineConfig({
  root: here,
  // Separate from any other dev server's cache, which shares node_modules.
  cacheDir: resolve(repoRoot, "node_modules/.vite/e2e-harness"),
  resolve: {
    alias: {
      "@gramaziokohler/llhil-webxr": resolve(repoRoot, "src/index.ts"),
    },
  },
  server: {
    // localhost is a secure context, so WebXR is available without TLS.
    host: "localhost",
    port: 5199,
    strictPort: true,
    fs: {
      // node_modules may be a symlink to an install outside the repository.
      allow: [repoRoot, realpathSync(resolve(repoRoot, "node_modules"))],
    },
  },
  optimizeDeps: {
    entries: [resolve(here, "index.html")],
    // Pre-bundled up front: discovering them at runtime would reload the page mid-test.
    include: ["three", "iwer", "@iwer/sem"],
  },
});
