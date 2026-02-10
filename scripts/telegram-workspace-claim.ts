import { Api, TelegramClient } from "npm:telegram@2.26.22";
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js";
import { getKvClient } from "../src/github/utils/kv-client.ts";
import { claimTelegramWorkspace } from "../src/telegram/workspace-store.ts";

type TelegramSecretsFile = {
  botToken?: string;
  mode?: string;
  apiId?: number | string;
  apiHash?: string;
  userSession?: string;
};

type CliOptions = Readonly<{
  secretsFile: string;
  inviteLink?: string;
  title?: string;
  userId?: number;
}>;

const opts = parseArgs(Deno.args);
const secrets = await loadTelegramSecrets(opts.secretsFile);

const botToken = secrets.botToken?.trim() ?? "";
if (!botToken) {
  throw new Error(`Missing botToken in ${opts.secretsFile}`);
}

const apiId = parsePositiveInt(secrets.apiId);
const apiHash = secrets.apiHash?.trim() ?? "";
const session = secrets.userSession?.trim() ?? "";
if (!apiId || !apiHash || !session) {
  throw new Error(`Missing Telegram user MTProto config in ${opts.secretsFile}.`);
}

const kv = await getKvClient();
if (!kv) {
  throw new Error("Deno KV is unavailable, so the workspace cannot be claimed.");
}

const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 2 });
await client.connect();
const authorized = await client.isUserAuthorized();
if (!authorized) {
  await client.disconnect();
  throw new Error("Telegram MTProto session is not authorized.");
}

const me = await client.getMe();
const defaultUserId = parsePositiveInt(me.id);
const userId = opts.userId ?? defaultUserId;
if (!userId) {
  await client.disconnect();
  throw new Error("Could not determine a numeric Telegram user ID for claiming.");
}

const channel = await resolveChannel({ client, inviteLink: opts.inviteLink, title: opts.title });
await client.disconnect();

const channelIdStr = normalizeTelegramIdToString(channel.id);
if (!channelIdStr) {
  throw new Error("Failed to read Telegram channel id.");
}

// Bot API supergroup chat id is `-100` + MTProto channel id.
const botChatIdStr = `-100${channelIdStr}`;
const chatId = parseNonZeroInt(botChatIdStr);
if (!chatId) {
  throw new Error("Failed to compute Bot API chat id for the channel.");
}

const botId = getTelegramBotId(botToken);
const result = await claimTelegramWorkspace({
  kv,
  botId,
  userId,
  chatId,
});

if (!result.ok) {
  throw new Error(result.error);
}

console.log(result.changed ? `Workspace claimed: chatId=${chatId} userId=${userId}` : `Workspace already claimed: chatId=${chatId} userId=${userId}`);

function parseArgs(args: string[]): CliOptions {
  const opts: { secretsFile?: string; inviteLink?: string; title?: string; userId?: number } = {};
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i] ?? "";
    if (!raw) continue;
    const [key, valueInline] = raw.startsWith("--") ? raw.split("=", 2) : [raw, undefined];
    const value = valueInline ?? args[i + 1];

    if (key === "--secrets-file") {
      if (valueInline === undefined) i += 1;
      opts.secretsFile = value;
    } else if (key === "--invite") {
      if (valueInline === undefined) i += 1;
      opts.inviteLink = typeof value === "string" ? value : undefined;
    } else if (key === "--title") {
      if (valueInline === undefined) i += 1;
      opts.title = typeof value === "string" ? value : undefined;
    } else if (key === "--user-id") {
      if (valueInline === undefined) i += 1;
      opts.userId = parsePositiveInt(value);
    }
  }

  return {
    secretsFile: opts.secretsFile?.trim() || ".secrets/telegram.json",
    inviteLink: opts.inviteLink?.trim() || undefined,
    title: opts.title?.trim() || undefined,
    userId: opts.userId,
  };
}

async function loadTelegramSecrets(path: string): Promise<TelegramSecretsFile> {
  const raw = await Deno.readTextFile(path);
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as TelegramSecretsFile;
}

async function resolveChannel(params: { client: TelegramClient; inviteLink?: string; title?: string }): Promise<Api.Channel> {
  if (params.inviteLink?.trim()) {
    const hash = extractInviteHash(params.inviteLink.trim());
    if (!hash) {
      throw new Error("Invalid invite link. Expected https://t.me/+<hash> or https://t.me/joinchat/<hash>.");
    }
    const invite = await params.client.invoke(new Api.messages.CheckChatInvite({ hash }));
    if (invite instanceof Api.ChatInviteAlready && invite.chat instanceof Api.Channel) {
      return invite.chat;
    }
    throw new Error("Invite link did not resolve to a joined supergroup for this user session.");
  }

  if (params.title?.trim()) {
    // Best-effort lookup by title for already-joined groups.
    const title = params.title.trim();
    for await (const dialog of params.client.iterDialogs({})) {
      const entity = dialog.entity;
      if (entity instanceof Api.Channel) {
        const dialogTitle = typeof entity.title === "string" ? entity.title.trim() : "";
        if (dialogTitle === title) return entity;
      }
    }
    throw new Error(`No joined supergroup found with title "${title}".`);
  }

  throw new Error("Provide either --invite <link> or --title <group title>.");
}

function extractInviteHash(value: string): string | null {
  const trimmed = value.trim();
  const plus = /^https?:\/\/t\.me\/\+([A-Za-z0-9_-]+)$/i.exec(trimmed);
  if (plus?.[1]) return plus[1];
  const joinChat = /^https?:\/\/t\.me\/joinchat\/([A-Za-z0-9_-]+)$/i.exec(trimmed);
  if (joinChat?.[1]) return joinChat[1];
  return null;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === "bigint") {
    if (value <= 0n) return undefined;
    const asNumber = Number(value);
    return Number.isFinite(asNumber) && Number.isSafeInteger(asNumber) ? asNumber : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.trunc(parsed);
    return normalized > 0 ? normalized : undefined;
  }
  if (value && typeof value === "object" && "toString" in value && typeof (value as { toString: () => string }).toString === "function") {
    return parsePositiveInt((value as { toString: () => string }).toString());
  }
  return undefined;
}

function parseNonZeroInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized !== 0 ? normalized : null;
  }
  if (typeof value === "bigint") {
    if (value === 0n) return null;
    const asNumber = Number(value);
    return Number.isFinite(asNumber) && Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
  }
  return null;
}

function normalizeTelegramIdToString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value && typeof value === "object" && "toString" in value && typeof (value as { toString: () => string }).toString === "function") {
    const rendered = (value as { toString: () => string }).toString();
    return normalizeTelegramIdToString(rendered);
  }
  return null;
}

function getTelegramBotId(botToken: string): string {
  const trimmed = botToken.trim();
  const index = trimmed.indexOf(":");
  if (index === -1) return trimmed;
  return trimmed.slice(0, index).trim();
}
