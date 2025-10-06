// deno-adapter/generate-deno-entry.ts
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const _dirname = dirname(fileURLToPath(import.meta.url));
console.log("Dir name:", _dirname);
const pluginEntry = process.argv[2] || "./adapters/server";
const outDir = resolve(_dirname, "src");
const outFile = resolve(outDir, "deno.ts");

mkdirSync(outDir, { recursive: true });

const content = `import worker from "${pluginEntry}";
export default {
  async fetch(request: Request, env: Record<string, unknown>, executionCtx?: ExecutionContext) {
    Object.assign(env, Deno.env.toObject());
    return worker.fetch(request, env, executionCtx);
  },
};
`;

writeFileSync(outFile, content);

console.log("Generated:", outFile);
