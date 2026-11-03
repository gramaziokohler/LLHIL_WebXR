import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: "esm",
  dts: true,
  sourcemap: true,
  minify: false,
  fixedExtension: false,
  external: [/^three(\/.*)?$/],
});
