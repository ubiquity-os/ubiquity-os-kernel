type LoggerLike = Readonly<{
  warn?: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}>;

const TELEGRAM_WORKSPACE_CREATE_ERROR = "Failed to create the workspace group in Telegram.";
const TELEGRAM_BOT_IDENTITY_ERROR = "Failed to resolve Telegram bot identity.";

type TelegramGramJsModule = typeof import("npm:telegram@2.26.22");
type TelegramGramJsSessionsModule = typeof import("npm:telegram@2.26.22/sessions/index.js");
type TelegramGramJsChannel = InstanceType<TelegramGramJsModule["Api"]["Channel"]>;

export type TelegramUserMtprotoConfig = Readonly<{
  apiId: number;
  apiHash: string;
  userSession: string;
}>;

export type CreateTelegramWorkspaceResult =
  | { ok: true; chatId: number; title: string }
  | {
      ok: false;
      error: string;
    };

export async function createTelegramWorkspaceForumSupergroup(params: {
  mtproto: TelegramUserMtprotoConfig;
  botToken: string;
  title: string;
  about: string;
  logger?: LoggerLike;
}): Promise<CreateTelegramWorkspaceResult> {
  const apiId = Math.trunc(params.mtproto.apiId);
  const apiHash = params.mtproto.apiHash.trim();
  const userSession = params.mtproto.userSession.trim();
  if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash || !userSession) {
    return { ok: false, error: "Telegram MTProto credentials are missing. Populate UOS_TELEGRAM.apiId/apiHash/userSession." };
  }

  let telegram: TelegramGramJsModule;
  let sessions: TelegramGramJsSessionsModule;
  try {
    telegram = await import("npm:telegram@2.26.22");
    sessions = await import("npm:telegram@2.26.22/sessions/index.js");
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Failed to load Telegram MTProto client (GramJS)");
    return { ok: false, error: "Telegram MTProto support is unavailable in this runtime." };
  }

  const { Api, TelegramClient, utils } = telegram;
  const { StringSession } = sessions;

  const botUsernameResult = await resolveBotUsername(params.botToken, params.logger);
  if (!botUsernameResult.ok) return botUsernameResult;

  const client = new TelegramClient(new StringSession(userSession), apiId, apiHash, { connectionRetries: 2 });
  try {
    await client.connect();
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Failed to connect Telegram MTProto client");
    return { ok: false, error: "Failed to connect to Telegram MTProto." };
  }

  try {
    const authorized = await client.isUserAuthorized();
    if (!authorized) {
      await client.disconnect();
      return { ok: false, error: "Telegram MTProto session is not authorized. Run: deno task telegram:user:login:write" };
    }

    const updates = await client.invoke(
      new Api.channels.CreateChannel({
        title: params.title,
        about: params.about,
        megagroup: true,
      })
    );

    const createdChannel = extractCreatedChannel(updates, Api);
    if (!createdChannel) {
      await client.disconnect();
      return { ok: false, error: TELEGRAM_WORKSPACE_CREATE_ERROR };
    }

    const inputChannel = utils.getInputChannel(createdChannel);

    await client.invoke(new Api.channels.ToggleForum({ channel: inputChannel, enabled: true }));

    const botEntity = await client.getEntity(`@${botUsernameResult.username}`);
    const botInputUser = utils.getInputUser(botEntity);
    await client.invoke(new Api.channels.InviteToChannel({ channel: inputChannel, users: [botInputUser] }));

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
          addAdmins: true, // allow bot to promote the requester to admin during bootstrap finalization
        }),
        rank: "UbiquityOS",
      })
    );

    // UX: don't keep the MTProto "bootstrap" user as a member, so @mention autocomplete in the workspace
    // only suggests the bot (and the workspace can be treated as ephemeral).
    try {
      await client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel }));
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to leave Telegram workspace channel as MTProto user");
    }

    await client.disconnect();

    const chatId = computeBotApiChatId(createdChannel.id);
    if (!chatId) {
      return { ok: false, error: "Workspace group created, but failed to compute its Bot API chat id." };
    }

    const title = typeof createdChannel.title === "string" && createdChannel.title.trim() ? createdChannel.title.trim() : params.title;
    return { ok: true, chatId, title };
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Telegram MTProto workspace bootstrap failed");
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }
    return { ok: false, error: TELEGRAM_WORKSPACE_CREATE_ERROR };
  }
}

type BotUsernameResult = Readonly<{ ok: true; username: string }> | Readonly<{ ok: false; error: string }>;

async function resolveBotUsername(botToken: string, logger?: LoggerLike): Promise<BotUsernameResult> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger?.warn?.({ status: response.status, detail }, "Failed to resolve Telegram bot username");
      return { ok: false, error: TELEGRAM_BOT_IDENTITY_ERROR };
    }
    const data = (await response.json().catch(() => null)) as { ok?: boolean; result?: { username?: unknown } } | null;
    const username = data?.result?.username;
    if (typeof username !== "string" || !username.trim()) {
      return { ok: false, error: TELEGRAM_BOT_IDENTITY_ERROR };
    }
    return { ok: true, username: username.trim() };
  } catch (error) {
    logger?.warn?.({ err: error }, "Failed to resolve Telegram bot username");
    return { ok: false, error: TELEGRAM_BOT_IDENTITY_ERROR };
  }
}

function extractCreatedChannel(updates: unknown, api: TelegramGramJsModule["Api"]): TelegramGramJsChannel | null {
  if (!updates || typeof updates !== "object") return null;
  const record = updates as { chats?: unknown };
  if (!Array.isArray(record.chats)) return null;
  for (const chat of record.chats) {
    if (chat instanceof api.Channel) return chat;
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
    return normalizeTelegramIdToString((value as { toString: () => string }).toString());
  }
  return null;
}

function computeBotApiChatId(channelId: unknown): number | null {
  const idStr = normalizeTelegramIdToString(channelId);
  if (!idStr) return null;
  // Bot API supergroup chat id is `-100` + MTProto channel id.
  const botChatIdStr = `-100${idStr}`;
  const chatId = Number.parseInt(botChatIdStr, 10);
  if (!Number.isFinite(chatId) || !Number.isSafeInteger(chatId) || chatId === 0) return null;
  return chatId;
}
