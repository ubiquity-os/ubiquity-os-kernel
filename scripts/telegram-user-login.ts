import { TelegramClient } from "npm:telegram@2.26.22";
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js";

type TelegramSecretsFile = {
  botToken?: string;
  webhookSecret?: string;
  mode?: string;
  apiId?: number | string;
  apiHash?: string;
  userSession?: string;
};

type CliOptions = Readonly<{
  secretsFile: string;
  apiId?: number;
  apiHash?: string;
  phone?: string;
  write: boolean;
}>;

const opts = parseArgs(Deno.args);
const secrets = await loadTelegramSecrets(opts.secretsFile);

const apiId = opts.apiId ?? parsePositiveInt(secrets.apiId) ?? (await promptForApiId());
const apiHash = opts.apiHash ?? secrets.apiHash?.trim() ?? (await promptForSecret("Telegram api_hash"));
const existingSession = secrets.userSession?.trim() ?? "";

const client = new TelegramClient(new StringSession(existingSession), apiId, apiHash, {
  connectionRetries: 3,
});

await client.start({
  phoneNumber: async () => opts.phone ?? (await promptForNonEmpty("Telegram phone number (ex: +15551234567)")),
  password: async () => prompt("2FA password (if enabled, else leave blank)") ?? "",
  phoneCode: async () => await promptForNonEmpty("Login code (sent by Telegram)"),
  onError: (err) => console.error(err),
});

const session = (client.session as unknown as { save(): string }).save();
const me = await client.getMe();
await client.disconnect();

console.log("");
console.log("MTProto session generated.");
console.log(`Account: ${formatTelegramAccountLabel(me)}`);
console.log("");
console.log("Session string (keep this secret):");
console.log(session);
console.log("");

if (opts.write) {
  const updated: TelegramSecretsFile = {
    ...secrets,
    apiId,
    apiHash,
    userSession: session,
  };
  if ("user" in (updated as Record<string, unknown>)) {
    delete (updated as Record<string, unknown>).user;
  }
  await Deno.writeTextFile(opts.secretsFile, JSON.stringify(updated, null, 2) + "\n");
  console.log(`Wrote session to ${opts.secretsFile}`);
  console.log("");
}

console.log("Next:");
console.log("1) Start the kernel with Telegram ingress enabled using this session.");
console.log("2) DM the bot and run: /workspace");

function parseArgs(args: string[]): CliOptions {
  const opts: {
    secretsFile?: string;
    apiId?: number;
    apiHash?: string;
    phone?: string;
    write?: boolean;
  } = {};

  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i] ?? "";
    if (!raw) continue;

    if (raw === "--write") {
      opts.write = true;
      continue;
    }

    const [key, valueInline] = raw.startsWith("--") ? raw.split("=", 2) : [raw, undefined];
    const value = valueInline ?? args[i + 1];

    if (key === "--secrets-file") {
      if (valueInline === undefined) i += 1;
      opts.secretsFile = value;
    } else if (key === "--api-id") {
      if (valueInline === undefined) i += 1;
      const parsed = parsePositiveInt(value);
      if (parsed !== undefined) opts.apiId = parsed;
    } else if (key === "--api-hash") {
      if (valueInline === undefined) i += 1;
      if (typeof value === "string" && value.trim()) opts.apiHash = value.trim();
    } else if (key === "--phone") {
      if (valueInline === undefined) i += 1;
      if (typeof value === "string" && value.trim()) opts.phone = value.trim();
    }
  }

  return {
    secretsFile: opts.secretsFile?.trim() || ".secrets/telegram.json",
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    phone: opts.phone,
    write: opts.write === true,
  };
}

async function loadTelegramSecrets(path: string): Promise<TelegramSecretsFile> {
  try {
    const raw = await Deno.readTextFile(path);
    const trimmed = raw.trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as TelegramSecretsFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    throw error;
  }
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.trunc(parsed);
    return normalized > 0 ? normalized : undefined;
  }
  return undefined;
}

async function promptForApiId(): Promise<number> {
  const raw = await promptForNonEmpty("Telegram api_id (from my.telegram.org)");
  const parsed = parsePositiveInt(raw);
  if (!parsed) {
    throw new Error("Invalid api_id");
  }
  return parsed;
}

async function promptForSecret(label: string): Promise<string> {
  return promptForNonEmpty(label);
}

async function promptForNonEmpty(label: string): Promise<string> {
  const value = prompt(`${label}:`) ?? "";
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function formatTelegramAccountLabel(me: Awaited<ReturnType<TelegramClient["getMe"]>>): string {
  const username = typeof me.username === "string" && me.username.trim() ? `@${me.username.trim()}` : null;
  const id = typeof me.id === "number" && Number.isFinite(me.id) ? String(me.id) : null;
  const parts = [username, id ? `id=${id}` : null].filter(Boolean);
  return parts.length ? parts.join(" ") : "(unknown account)";
}
