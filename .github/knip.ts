import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/worker.ts"],
  project: ["src/**/*.ts"],
  ignoreBinaries: ["i", "format:cspell"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: ["@mswjs/data", "esbuild", "eslint-config-prettier", "eslint-plugin-prettier", "msw"],
};

export default config;
