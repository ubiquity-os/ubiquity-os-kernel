import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/kernel.ts", "src/adapters/cloudflare-worker.ts", "deploy/setup-kv-namespace.ts", "src/index.ts"],
  project: ["src/**/*.ts"],
  ignore: ["jest.config.ts"],
  ignoreBinaries: ["i"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: ["@mswjs/data", "esbuild", "eslint-config-prettier", "eslint-plugin-prettier", "msw", "ts-node"],
};

export default config;
