import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/sdk/index.ts"],
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
});
