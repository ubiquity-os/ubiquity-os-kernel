import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/kernel.ts", "src/adapters/cloudflare-worker.ts", "src/index.ts"],
  project: ["src/**/*.ts"],
  ignore: ["jest.config.ts"],
  ignoreBinaries: ["i"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: ["esbuild", "eslint-config-prettier", "eslint-plugin-prettier", "msw", "ts-node"],
};

export default config;
