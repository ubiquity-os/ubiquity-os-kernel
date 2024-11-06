import { defineConfig } from "tsup";
import { createCleanPackageJson } from "./sdk-build-script";

const entries = ["src/sdk/index.ts", "src/types/index.ts"];

export default defineConfig({
  entry: ["src/sdk/index.ts", "src/types/index.ts"],
  format: ["cjs", "esm"],
  outDir: "dist",
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: true,
  legacyOutput: false,
  onSuccess: async () => {
    await buildPackageJsons();
  },
});

/**
 * 1. Cleans up the SDK dist package.json
 * 2. Pretty sure this is required for declaring multiple directories in the exports field
 */
async function buildPackageJsons() {
  const dirs = entries.map((entry) => entry.split("/")[1]);
  for (const entry of dirs) {
    await createCleanPackageJson(entry);
  }

  await createCleanPackageJson("", true, dirs)
}
