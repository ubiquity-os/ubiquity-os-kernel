type Options = Readonly<{
  outPath: string;
  token: string;
  baseUrl: string;
}>;

const DEFAULT_OUT = ".secrets/ai.json";
const DEFAULT_BASE_URL = "https://ai-ubq-fi.deno.dev";
const USAGE = `
Generate .secrets/ai.json for UOS_AI.

Usage:
  deno run --allow-env --allow-write scripts/ai-secrets.ts [options]

Options:
  --token <value>       AI token (recommended)
  --token-env <name>    Read token from environment variable
  --base-url <url>      Override base URL (default: ${DEFAULT_BASE_URL})
  --out <path>          Output path (default: ${DEFAULT_OUT})
  -h, --help            Show this help

Examples:
  deno run --allow-env --allow-write scripts/ai-secrets.ts --token-env DENO_DEPLOY_TOKEN
  deno run --allow-env --allow-write scripts/ai-secrets.ts --token "$UOS_AI_TOKEN" --out .secrets/ai.json
`.trim();

function parseArgs(args: string[]): { token?: string; tokenEnv?: string; baseUrl?: string; outPath?: string } {
  const result: { token?: string; tokenEnv?: string; baseUrl?: string; outPath?: string } = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      Deno.exit(0);
    }
    if (arg === "--token" && args[i + 1]) {
      result.token = String(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--token=")) {
      result.token = arg.split("=").slice(1).join("=");
      continue;
    }
    if (arg === "--token-env" && args[i + 1]) {
      result.tokenEnv = String(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--token-env=")) {
      result.tokenEnv = arg.split("=").slice(1).join("=");
      continue;
    }
    if (arg === "--base-url" && args[i + 1]) {
      result.baseUrl = String(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      result.baseUrl = arg.split("=").slice(1).join("=");
      continue;
    }
    if (arg === "--out" && args[i + 1]) {
      result.outPath = String(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      result.outPath = arg.split("=").slice(1).join("=");
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      console.log(USAGE);
      Deno.exit(1);
    }
  }
  return result;
}

function resolveToken(token?: string, tokenEnv?: string): string {
  if (token && token.trim()) return token.trim();
  if (tokenEnv) {
    const envValue = Deno.env.get(tokenEnv);
    if (envValue && envValue.trim()) return envValue.trim();
    throw new Error(`Environment variable ${tokenEnv} is not set.`);
  }
  throw new Error("Missing token. Provide --token or --token-env.");
}

function resolveOptions(args: string[]): Options {
  const parsed = parseArgs(args);
  const token = resolveToken(parsed.token, parsed.tokenEnv);
  const baseUrl = parsed.baseUrl?.trim() || DEFAULT_BASE_URL;
  const outPath = parsed.outPath?.trim() || DEFAULT_OUT;
  return { token, baseUrl, outPath };
}

function main() {
  const options = resolveOptions(Deno.args);
  const payload = {
    baseUrl: options.baseUrl,
    token: options.token,
  };
  Deno.writeTextFileSync(options.outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${options.outPath}`);
}

if (import.meta.main) {
  main();
}
