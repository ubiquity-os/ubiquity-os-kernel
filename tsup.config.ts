import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/functions/*.ts"],
  splitting: false,
  sourcemap: false,
  clean: true,
  format: ["esm"],
  minify: true,
});
