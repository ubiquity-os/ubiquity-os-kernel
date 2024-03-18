import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/worker.ts"],
  project: ["src/**/*.ts"],
  ignoreBinaries: ["build", "i", "format:cspell", "awk", "lsof"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: ["@mswjs/data", "esbuild", "eslint-config-prettier", "eslint-plugin-prettier"],
};

export default config;
