import { Api, TelegramClient, utils } from "npm:telegram@2.26.22";
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js";
import { getKvClient } from "../src/github/utils/kv-client.ts";
import { claimTelegramWorkspace } from "../src/telegram/workspace-store.ts";

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
  title: string;
  about: string;
}>;

type TelegramWorkspaceChannelMeta = Readonly<{
  label: string;
  botChatId: number | null;
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
  throw new Error(`Missing Telegram user MTProto config in ${opts.secretsFile}. Run: deno task telegram:user:login:write`);
}

const botUsername = await resolveBotUsername(botToken);
const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
  connectionRetries: 3,
});

await client.connect();
const authorized = await client.isUserAuthorized();
if (!authorized) {
  await client.disconnect();
  throw new Error("Telegram MTProto session is not authorized. Run: deno task telegram:user:login:write");
}

const me = await client.getMe();

console.log(`Creating forum supergroup as ${formatTelegramAccountLabel(me)}...`);

const updates = await client.invoke(
  new Api.channels.CreateChannel({
    title: opts.title,
    about: opts.about,
    megagroup: true,
  })
);

const createdChannel = extractCreatedChannel(updates);
if (!createdChannel) {
  await client.disconnect();
  throw new Error("Failed to detect created supergroup in Telegram response.");
}

const inputChannel = utils.getInputChannel(createdChannel);
const inputPeer = utils.getInputPeer(createdChannel);

const workspaceMeta = describeChannel(createdChannel);
console.log(`Created: ${workspaceMeta.label}`);
console.log("Enabling Topics (forum)...");
await client.invoke(new Api.channels.ToggleForum({ channel: inputChannel, enabled: true }));

console.log(`Adding bot @${botUsername}...`);
const botEntity = await client.getEntity(`@${botUsername}`);
const botInputUser = utils.getInputUser(botEntity);
await client.invoke(new Api.channels.InviteToChannel({ channel: inputChannel, users: [botInputUser] }));

console.log("Promoting bot (Manage Topics)...");
await client.invoke(
  new Api.channels.EditAdmin({
    channel: inputChannel,
    userId: botInputUser,
    adminRights: new Api.ChatAdminRights({
      changeInfo: true,
      inviteUsers: true,
      pinMessages: true,
      manageTopics: true,
      deleteMessages: true,
      banUsers: true,
      manageCall: true,
      other: true,
      addAdmins: true,
    }),
    rank: "UbiquityOS",
  })
);

console.log("Exporting invite link...");
const invite = await client.invoke(new Api.messages.ExportChatInvite({ peer: inputPeer }));
const inviteLink = (invite as { link?: unknown }).link;
const link = typeof inviteLink === "string" && inviteLink.trim() ? inviteLink.trim() : null;

await client.disconnect();

const kv = await getKvClient();
if (kv && workspaceMeta.botChatId) {
  const botId = getTelegramBotId(botToken);
  const userId = parsePositiveInt(me.id);
  if (userId) {
    const claimed = await claimTelegramWorkspace({
      kv,
      botId,
      userId,
      chatId: workspaceMeta.botChatId,
    });
    if (!claimed.ok) {
      console.warn(`Workspace claim skipped: ${claimed.error}`);
    } else if (claimed.changed) {
      console.log(`Workspace claimed in KV (chatId=${workspaceMeta.botChatId}).`);
    } else {
      console.log(`Workspace already claimed in KV (chatId=${workspaceMeta.botChatId}).`);
    }
  } else {
    console.warn("Workspace claim skipped: could not parse a numeric Telegram user id.");
  }
} else if (!kv) {
  console.warn("Workspace claim skipped: Deno KV unavailable (workspace mappings can't be persisted).");
} else {
  console.warn("Workspace claim skipped: could not compute Bot API chat id (workspace mappings can't be persisted).");
}

console.log("");
console.log("Workspace created.");
console.log(`Bot: @${botUsername}`);
console.log(`Group: ${workspaceMeta.label}`);
if (workspaceMeta.botChatId) {
  console.log(`Bot API chat id: ${workspaceMeta.botChatId}`);
}
console.log("");
if (link) {
  console.log("Invite link:");
  console.log(link);
  console.log("");
}
console.log("Next in Telegram:");
console.log("1) Join/open the group");
console.log("2) Create a topic per context with /topic <github-url>");

function parseArgs(args: string[]): CliOptions {
  const opts: { secretsFile?: string; title?: string; about?: string } = {};
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i] ?? "";
    if (!raw) continue;
    const [key, valueInline] = raw.startsWith("--") ? raw.split("=", 2) : [raw, undefined];
    const value = valueInline ?? args[i + 1];

    if (key === "--secrets-file") {
      if (valueInline === undefined) i += 1;
      opts.secretsFile = value;
    } else if (key === "--title") {
      if (valueInline === undefined) i += 1;
      opts.title = typeof value === "string" ? value : undefined;
    } else if (key === "--about") {
      if (valueInline === undefined) i += 1;
      opts.about = typeof value === "string" ? value : undefined;
    }
  }

  return {
    secretsFile: opts.secretsFile?.trim() || ".secrets/telegram.json",
    title: opts.title?.trim() || "UbiquityOS Workspace",
    about: opts.about?.trim() || "UbiquityOS workspace group.",
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

async function resolveBotUsername(botToken: string): Promise<string> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to resolve bot username (status ${response.status}). ${detail}`);
  }
  const data = (await response.json().catch(() => null)) as { ok?: boolean; result?: { username?: unknown } } | null;
  const username = data?.result?.username;
  if (typeof username !== "string" || !username.trim()) {
    throw new Error("Bot username missing from getMe response.");
  }
  return username.trim();
}

function extractCreatedChannel(updates: unknown): Api.Channel | null {
  if (!updates || typeof updates !== "object") return null;
  const record = updates as { chats?: unknown };
  if (!Array.isArray(record.chats)) return null;
  for (const chat of record.chats) {
    if (chat instanceof Api.Channel) {
      return chat;
    }
  }
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

function describeChannel(channel: Api.Channel): TelegramWorkspaceChannelMeta {
  const title = typeof channel.title === "string" && channel.title.trim() ? channel.title.trim() : "(no title)";
  let channelIdStr: string | null = null;
  if (typeof channel.id === "number" && Number.isFinite(channel.id)) {
    channelIdStr = String(Math.trunc(channel.id));
  } else if (typeof channel.id === "bigint") {
    channelIdStr = channel.id.toString();
  } else if (
    channel.id &&
    typeof channel.id === "object" &&
    "toString" in channel.id &&
    typeof (channel.id as { toString: () => string }).toString === "function"
  ) {
    channelIdStr = (channel.id as { toString: () => string }).toString();
  }

  const botChatIdStr = channelIdStr ? `-100${channelIdStr}` : null;
  const botChatId = botChatIdStr ? Number.parseInt(botChatIdStr, 10) : null;
  const labelParts = [title, channelIdStr ? `channel_id=${channelIdStr}` : null, botChatIdStr ? `bot_chat_id=${botChatIdStr}` : null].filter(Boolean);

  return {
    label: labelParts.join(" "),
    botChatId: botChatId && Number.isFinite(botChatId) && Number.isSafeInteger(botChatId) ? botChatId : null,
  };
}

function formatTelegramAccountLabel(me: Awaited<ReturnType<TelegramClient["getMe"]>>): string {
  const username = typeof me.username === "string" && me.username.trim() ? `@${me.username.trim()}` : null;
  const id = parsePositiveInt(me.id) ? String(parsePositiveInt(me.id)) : null;
  const parts = [username, id ? `id=${id}` : null].filter(Boolean);
  return parts.length ? parts.join(" ") : "(unknown account)";
}

function getTelegramBotId(botToken: string): string {
  const trimmed = botToken.trim();
  const index = trimmed.indexOf(":");
  if (index === -1) return trimmed;
  return trimmed.slice(0, index).trim();
}
