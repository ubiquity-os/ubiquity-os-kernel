import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/worker.ts", "deploy/setup-kv-namespace.ts"],
  project: ["src/**/*.ts"],
  ignore: ["jest.config.ts"],
  ignoreBinaries: ["i", "publish"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: ["@mswjs/data", "esbuild", "eslint-config-prettier", "eslint-plugin-prettier", "msw", "ts-node"],
};

export default config;
