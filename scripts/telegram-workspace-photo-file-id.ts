type TelegramSecretsFile = {
  botToken?: string;
  webhookSecret?: string;
  mode?: string;
  apiId?: number | string;
  apiHash?: string;
  userSession?: string;
  workspacePhotoFileId?: string;
};

type CliOptions = Readonly<{
  secretsFile: string;
  chatId?: number;
  write: boolean;
}>;

const opts = parseArgs(Deno.args);
if (!opts.chatId) {
  printHelp("Missing --chat-id");
  Deno.exit(1);
}

const secrets = await loadTelegramSecrets(opts.secretsFile);
const botToken = secrets.botToken?.trim() ?? "";
if (!botToken) {
  throw new Error(`Missing botToken in ${opts.secretsFile}`);
}

const chat = await fetchTelegramChat({ botToken, chatId: opts.chatId });
if (!chat.ok) {
  const suffix = chat.description ? ` ${chat.description}` : "";
  throw new Error(`getChat failed (status ${chat.status ?? "unknown"}).${suffix}`);
}

const photo = chat.chat.photo;
const bigFileId = typeof photo?.big_file_id === "string" && photo.big_file_id.trim() ? photo.big_file_id.trim() : null;
const smallFileId = typeof photo?.small_file_id === "string" && photo.small_file_id.trim() ? photo.small_file_id.trim() : null;

console.log(`chat_id: ${opts.chatId}`);
console.log(`title: ${chat.chat.title ?? "(no title)"}`);
console.log(`type: ${chat.chat.type ?? "(unknown)"}`);
console.log("");

if (!bigFileId && !smallFileId) {
  console.log("No chat photo found on this chat.");
  Deno.exit(0);
}

if (bigFileId) {
  console.log("photo.big_file_id:");
  console.log(bigFileId);
  console.log("");
}

if (smallFileId) {
  console.log("photo.small_file_id:");
  console.log(smallFileId);
  console.log("");
}

if (opts.write && bigFileId) {
  const updated: TelegramSecretsFile = { ...secrets, workspacePhotoFileId: bigFileId };
  await Deno.writeTextFile(opts.secretsFile, JSON.stringify(updated, null, 2) + "\n");
  console.log(`Wrote workspacePhotoFileId to ${opts.secretsFile}`);
}

function parseArgs(args: string[]): CliOptions {
  const opts: { secretsFile?: string; chatId?: number; write?: boolean } = {};

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
      opts.secretsFile = typeof value === "string" ? value : undefined;
    } else if (key === "--chat-id") {
      if (valueInline === undefined) i += 1;
      const parsed = parseNumber(value);
      if (parsed !== null) opts.chatId = parsed;
    }
  }

  return {
    secretsFile: opts.secretsFile?.trim() || ".secrets/telegram.json",
    chatId: opts.chatId,
    write: opts.write === true,
  };
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
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

type TelegramChatPhoto = Readonly<{
  small_file_id?: unknown;
  big_file_id?: unknown;
}>;

type TelegramChat = Readonly<{
  id?: unknown;
  type?: unknown;
  title?: unknown;
  photo?: TelegramChatPhoto | null;
}>;

async function fetchTelegramChat(params: {
  botToken: string;
  chatId: number;
}): Promise<
  | { ok: true; chat: { type?: string; title?: string; photo?: { small_file_id?: string; big_file_id?: string } | null } }
  | { ok: false; status?: number; description?: string }
> {
  const response = await fetch(`https://api.telegram.org/bot${params.botToken}/getChat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: params.chatId }),
  });

  const status = response.status;
  const text = await response.text().catch(() => "");
  let parsed: { ok?: boolean; description?: unknown; result?: unknown } | null = null;
  try {
    parsed = JSON.parse(text) as { ok?: boolean; description?: unknown; result?: unknown };
  } catch {
    // ignore
  }

  if (!response.ok || parsed?.ok !== true) {
    const description = typeof parsed?.description === "string" && parsed.description.trim() ? parsed.description.trim() : undefined;
    return { ok: false, status, ...(description ? { description } : {}) };
  }

  const result = parsed?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, status, description: "Missing chat payload." };
  }

  const chat = result as TelegramChat;
  const type = typeof chat.type === "string" ? chat.type : undefined;
  const title = typeof chat.title === "string" ? chat.title : undefined;
  const photo = chat.photo && typeof chat.photo === "object" && !Array.isArray(chat.photo) ? (chat.photo as Record<string, unknown>) : null;
  const small = photo?.small_file_id;
  const big = photo?.big_file_id;

  return {
    ok: true,
    chat: {
      type,
      title,
      photo: photo
        ? {
            ...(typeof small === "string" && small.trim() ? { small_file_id: small.trim() } : {}),
            ...(typeof big === "string" && big.trim() ? { big_file_id: big.trim() } : {}),
          }
        : null,
    },
  };
}

function printHelp(error?: string) {
  if (error) console.error(error);
  console.log("");
  console.log("Extract a workspace chat photo file_id so the kernel can reuse it for new workspaces.");
  console.log("");
  console.log("Usage:");
  console.log("  deno run --allow-read --allow-net scripts/telegram-workspace-photo-file-id.ts --chat-id=-100123");
  console.log("  deno run --allow-read --allow-write --allow-net scripts/telegram-workspace-photo-file-id.ts --chat-id=-100123 --write");
  console.log("");
  console.log("Flags:");
  console.log("  --secrets-file=PATH   default: .secrets/telegram.json");
  console.log("  --chat-id=ID          required (supergroup ids are negative, start with -100...)");
  console.log("  --write               writes workspacePhotoFileId into secrets file (uses big_file_id)");
}
