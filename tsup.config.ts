import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/sdk/index.ts"],
  format: ["cjs", "esm"],
  outDir: "dist",
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: true,
  legacyOutput: false,
});
