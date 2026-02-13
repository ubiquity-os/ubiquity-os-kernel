type CliArgs = {
  pem?: string;
  out?: string;
  appId?: string;
  webhookSecret?: string;
  help?: boolean;
};

const args = parseArgs(Deno.args);
if (args.help) {
  printHelp();
  Deno.exit(0);
}

if (!args.pem) {
  printHelp("Missing required --pem path.");
  Deno.exit(1);
}

const outPath = args.out?.trim() || ".secrets/github.json";
const existing = await readExistingConfig(outPath);

const appId = args.appId?.trim() || existing?.appId;
const webhookSecret = args.webhookSecret?.trim() || existing?.webhookSecret;
const privateKey = normalizePem(await Deno.readTextFile(args.pem));

if (!appId) {
  printHelp("Missing appId. Provide --app-id or ensure it exists in the output file.");
  Deno.exit(1);
}
if (!webhookSecret) {
  printHelp("Missing webhookSecret. Provide --webhook-secret or ensure it exists in the output file.");
  Deno.exit(1);
}
if (!privateKey.trim()) {
  printHelp("Private key file is empty.");
  Deno.exit(1);
}

if (privateKey.includes("BEGIN RSA PRIVATE KEY") && !privateKey.includes("BEGIN PRIVATE KEY")) {
  console.warn("Warning: key appears to be PKCS#1. Convert to PKCS#8 (BEGIN PRIVATE KEY).");
}

const payload = {
  appId,
  webhookSecret,
  privateKey,
};

await Deno.mkdir(getDirName(outPath), { recursive: true });
await Deno.writeTextFile(outPath, JSON.stringify(payload, null, 2) + "\n");
console.log(`Wrote ${outPath}`);

function parseArgs(values: string[]): CliArgs {
  const result: CliArgs = {};
  for (let i = 0; i < values.length; i += 1) {
    const current = values[i];
    if (current === "--help" || current === "-h") {
      result.help = true;
      continue;
    }
    const eqIndex = current.indexOf("=");
    const key = eqIndex >= 0 ? current.slice(0, eqIndex) : current;
    const value = eqIndex >= 0 ? current.slice(eqIndex + 1) : values[i + 1];
    if (!key.startsWith("--")) continue;
    switch (key) {
      case "--pem":
        result.pem = value;
        if (eqIndex < 0) i += 1;
        break;
      case "--out":
        result.out = value;
        if (eqIndex < 0) i += 1;
        break;
      case "--app-id":
        result.appId = value;
        if (eqIndex < 0) i += 1;
        break;
      case "--webhook-secret":
        result.webhookSecret = value;
        if (eqIndex < 0) i += 1;
        break;
      default:
        break;
    }
  }
  return result;
}

function printHelp(error?: string) {
  if (error) {
    console.error(error);
  }
  console.log(`Usage:
  deno run --allow-read --allow-write scripts/github-secrets.ts --pem=path [--app-id=APP_ID] [--webhook-secret=SECRET] [--out=.secrets/github.json]

Examples:
  deno run --allow-read --allow-write scripts/github-secrets.ts --pem=key.pem --app-id=123 --webhook-secret=secret
  deno run --allow-read --allow-write scripts/github-secrets.ts --pem=key.pem`);
}

function normalizePem(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd() + "\n";
}

async function readExistingConfig(path: string): Promise<{ appId?: string; webhookSecret?: string } | null> {
  try {
    const raw = await Deno.readTextFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const appId = typeof parsed.appId === "string" ? parsed.appId.trim() : undefined;
    const webhookSecret = typeof parsed.webhookSecret === "string" ? parsed.webhookSecret.trim() : undefined;
    return { appId, webhookSecret };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function getDirName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return ".";
  return normalized.slice(0, index);
}
