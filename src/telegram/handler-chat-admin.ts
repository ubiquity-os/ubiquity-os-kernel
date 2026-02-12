import { deleteTelegramWorkspaceBootstrap, loadTelegramWorkspaceBootstrapByChat } from "./workspace-bootstrap-store.ts";
import { loadTelegramWorkspaceByChat, unclaimTelegramWorkspace } from "./workspace-store.ts";
import { parseOptionalPositiveInt } from "./normalization.ts";
import {
  type Logger,
  TELEGRAM_BOT_NOT_MEMBER_DESCRIPTION,
  TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION,
  TELEGRAM_SET_CHAT_PHOTO_ERROR,
  type TelegramChatMemberUpdated,
} from "./handler-shared.ts";
import { deleteTelegramRoutingOverridesForChat, getTelegramBotId, getTelegramKv } from "./handler-routing.ts";

export async function safeIsTelegramChatAdmin(params: { botToken: string; chatId: number; userId: number; logger: Logger }): Promise<boolean | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/getChatMember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        user_id: params.userId,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const description = tryParseTelegramErrorDescription(detail);
      params.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          status: response.status,
          detail,
          ...(description ? { description } : {}),
        },
        "Failed to verify Telegram admin status"
      );
      return null;
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { status?: string };
    } | null;
    const status = data?.result?.status ?? "";
    return status === "creator" || status === "administrator";
  } catch (error) {
    params.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        err: error,
      },
      "Failed to verify Telegram admin status"
    );
    return null;
  }
}

function tryParseTelegramErrorDescription(detail: string): string | null {
  const trimmed = detail.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { description?: unknown } | null;
    const description = parsed?.description;
    if (typeof description !== "string") return null;
    const normalized = description.trim();
    return normalized ? normalized : null;
  } catch {
    return null;
  }
}

export function isTelegramChatUnavailableError(description?: string): boolean {
  const normalized = (description ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("chat not found") ||
    normalized.includes("bot was kicked") ||
    normalized.includes(TELEGRAM_BOT_NOT_MEMBER_DESCRIPTION) ||
    normalized.includes("group chat was upgraded to a supergroup chat")
  );
}

export async function safeCreateTelegramChatInviteLink(params: {
  botToken: string;
  chatId: number;
  expireInSeconds?: number;
  memberLimit?: number;
  name?: string;
  logger: Logger;
}): Promise<
  | { ok: true; inviteLink: string }
  | {
      ok: false;
      error: string;
      status?: number;
      description?: string;
    }
> {
  const expireInSeconds = typeof params.expireInSeconds === "number" ? Math.trunc(params.expireInSeconds) : null;
  const memberLimit = typeof params.memberLimit === "number" ? Math.trunc(params.memberLimit) : null;
  if (expireInSeconds !== null && (!Number.isFinite(expireInSeconds) || expireInSeconds <= 0)) {
    return { ok: false, error: "Invalid invite link expiration." };
  }
  if (memberLimit !== null && (!Number.isFinite(memberLimit) || memberLimit <= 0)) {
    return { ok: false, error: "Invalid invite link limit." };
  }

  const expireDate = expireInSeconds === null ? null : Math.trunc(Date.now() / 1000) + expireInSeconds;

  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/createChatInviteLink`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        ...(params.name?.trim() ? { name: params.name.trim() } : {}),
        ...(expireDate !== null ? { expire_date: expireDate } : {}),
        ...(memberLimit !== null ? { member_limit: memberLimit } : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const description = tryParseTelegramErrorDescription(detail);
      params.logger.warn(
        {
          chatId: params.chatId,
          status: response.status,
          detail,
          ...(description ? { description } : {}),
        },
        "Failed to create Telegram invite link"
      );
      return {
        ok: false,
        status: response.status,
        ...(description ? { description } : {}),
        error: "Couldn't create an invite link. Ensure the bot can invite users in the group.",
      };
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { invite_link?: unknown };
    } | null;
    const inviteLink = data?.result?.invite_link;
    if (typeof inviteLink !== "string" || !inviteLink.trim()) {
      return { ok: false, error: "Couldn't create an invite link." };
    }
    return { ok: true, inviteLink: inviteLink.trim() };
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to create Telegram invite link");
    return { ok: false, error: "Couldn't create an invite link." };
  }
}

export async function safeSetTelegramChatPhoto(params: {
  botToken: string;
  chatId: number;
  photoFileId: string;
  logger: Logger;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const photoFileId = params.photoFileId.trim();
  if (!photoFileId) return { ok: false, error: "Missing photo file id." };

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await waitForTelegramBotChatPhotoPermission({
      botToken: params.botToken,
      chatId: params.chatId,
      logger: params.logger,
    });

    const result = await trySetTelegramChatPhotoOnce({
      botToken: params.botToken,
      chatId: params.chatId,
      photoFileId,
      logger: params.logger,
    });
    if (result.ok) return { ok: true };

    const isTransientFailure = isTransientTelegramChatPhotoFailure(result.description, result.detail);
    const shouldRetry = isTransientFailure && attempt < maxAttempts;
    if (!shouldRetry) {
      return { ok: false, error: result.error };
    }

    params.logger.warn(
      {
        chatId: params.chatId,
        attempt,
        maxAttempts,
        status: result.status,
        detail: result.detail,
        ...(result.description ? { description: result.description } : {}),
      },
      "Retrying Telegram setChatPhoto after transient failure"
    );
    await sleep(350 * attempt);
  }

  return { ok: false, error: TELEGRAM_SET_CHAT_PHOTO_ERROR };
}

type TelegramSetChatPhotoAttemptResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      status?: number;
      description?: string;
      detail?: string;
    };

async function trySetTelegramChatPhotoOnce(params: {
  botToken: string;
  chatId: number;
  photoFileId: string;
  logger: Logger;
}): Promise<TelegramSetChatPhotoAttemptResult> {
  try {
    const directSet = await postTelegramSetChatPhoto({
      botToken: params.botToken,
      body: JSON.stringify({
        chat_id: params.chatId,
        photo: params.photoFileId,
      }),
      headers: { "content-type": "application/json" },
    });
    if (directSet.ok) {
      return { ok: true };
    }

    params.logger.warn(
      {
        chatId: params.chatId,
        status: directSet.status,
        detail: directSet.detail,
        ...(directSet.description ? { description: directSet.description } : {}),
      },
      "Failed to set Telegram chat photo via file_id; retrying with file upload"
    );

    const fileLookup = await fetchTelegramFilePath({
      botToken: params.botToken,
      photoFileId: params.photoFileId,
    });
    if (!fileLookup.ok) {
      params.logger.warn(
        {
          chatId: params.chatId,
          status: fileLookup.status,
          detail: fileLookup.detail,
          ...(fileLookup.description ? { description: fileLookup.description } : {}),
        },
        "Failed to resolve Telegram workspace photo file path"
      );
      return {
        ok: false,
        error: TELEGRAM_SET_CHAT_PHOTO_ERROR,
        status: fileLookup.status,
        detail: fileLookup.detail,
        ...(fileLookup.description ? { description: fileLookup.description } : {}),
      };
    }

    const fileResponse = await fetch(`https://api.telegram.org/file/bot${params.botToken}/${fileLookup.filePath}`, { method: "GET" });
    if (!fileResponse.ok) {
      const detail = await fileResponse.text().catch(() => "");
      params.logger.warn(
        {
          chatId: params.chatId,
          status: fileResponse.status,
          detail,
        },
        "Failed to download Telegram workspace photo file"
      );
      return {
        ok: false,
        error: TELEGRAM_SET_CHAT_PHOTO_ERROR,
        status: fileResponse.status,
        detail,
      };
    }

    const fileBlob = await fileResponse.blob();
    if (fileBlob.size <= 0) {
      params.logger.warn({ chatId: params.chatId, filePath: fileLookup.filePath }, "Downloaded Telegram workspace photo file is empty");
      return {
        ok: false,
        error: TELEGRAM_SET_CHAT_PHOTO_ERROR,
        detail: "Downloaded workspace photo blob is empty.",
      };
    }

    const formData = new FormData();
    formData.set("chat_id", String(params.chatId));
    formData.set("photo", fileBlob, telegramFileNameFromPath(fileLookup.filePath));

    const uploadedSet = await postTelegramSetChatPhoto({
      botToken: params.botToken,
      body: formData,
    });
    if (!uploadedSet.ok) {
      params.logger.warn(
        {
          chatId: params.chatId,
          status: uploadedSet.status,
          detail: uploadedSet.detail,
          ...(uploadedSet.description ? { description: uploadedSet.description } : {}),
        },
        "Failed to set Telegram chat photo via multipart upload"
      );
      return {
        ok: false,
        error: TELEGRAM_SET_CHAT_PHOTO_ERROR,
        status: uploadedSet.status,
        detail: uploadedSet.detail,
        ...(uploadedSet.description ? { description: uploadedSet.description } : {}),
      };
    }

    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    params.logger.warn({ err: error, detail, chatId: params.chatId }, "Failed to set Telegram chat photo");
    return {
      ok: false,
      error: TELEGRAM_SET_CHAT_PHOTO_ERROR,
      detail,
    };
  }
}

function isTransientTelegramChatPhotoFailure(description?: string, detail?: string): boolean {
  const normalized = [description, detail]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("chat not found") ||
    normalized.includes("bot was kicked") ||
    normalized.includes(TELEGRAM_BOT_NOT_MEMBER_DESCRIPTION) ||
    normalized.includes("chat_admin_required") ||
    normalized.includes("right_forbidden") ||
    normalized.includes("not enough rights") ||
    normalized.includes("retry after")
  );
}

async function waitForTelegramBotChatPhotoPermission(params: { botToken: string; chatId: number; logger: Logger }): Promise<void> {
  const botUserId = parseOptionalPositiveInt(getTelegramBotId(params.botToken));
  if (!botUserId) return;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = await safeFetchTelegramChatMemberSnapshot({
      botToken: params.botToken,
      chatId: params.chatId,
      userId: botUserId,
    });
    if (snapshot.ok) {
      const status = (snapshot.snapshot.status ?? "").toLowerCase();
      const isAdmin = status === "creator" || status === "administrator";
      const canChangeInfo = status === "creator" || snapshot.snapshot.can_change_info === true;
      if (isAdmin && canChangeInfo) return;
      params.logger.debug(
        {
          chatId: params.chatId,
          botUserId,
          status: snapshot.snapshot.status,
          canChangeInfo: snapshot.snapshot.can_change_info,
          attempt,
          maxAttempts,
        },
        "Waiting for Telegram bot chat-photo permissions to propagate"
      );
    } else {
      params.logger.debug(
        {
          chatId: params.chatId,
          botUserId,
          attempt,
          maxAttempts,
          status: snapshot.status,
          ...(snapshot.description ? { description: snapshot.description } : {}),
          ...(snapshot.detail ? { detail: snapshot.detail } : {}),
        },
        "Waiting for Telegram bot membership snapshot before setting chat photo"
      );
    }
    if (attempt < maxAttempts) {
      await sleep(250 * attempt);
    }
  }
}

function sleep(ms: number): Promise<void> {
  const duration = Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : 0;
  return new Promise((resolve) => setTimeout(resolve, duration));
}

type TelegramBotApiCallResult =
  | { ok: true; status: number; detail: string; result?: unknown }
  | {
      ok: false;
      status: number;
      detail: string;
      description?: string;
      result?: unknown;
    };

async function postTelegramSetChatPhoto(params: { botToken: string; body: BodyInit; headers?: HeadersInit }): Promise<TelegramBotApiCallResult> {
  const response = await fetch(`https://api.telegram.org/bot${params.botToken}/setChatPhoto`, {
    method: "POST",
    ...(params.headers ? { headers: params.headers } : {}),
    body: params.body,
  });
  return readTelegramBotApiCallResult(response);
}

async function fetchTelegramFilePath(params: {
  botToken: string;
  photoFileId: string;
}): Promise<{ ok: true; filePath: string } | { ok: false; status: number; detail: string; description?: string }> {
  const response = await fetch(`https://api.telegram.org/bot${params.botToken}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: params.photoFileId }),
  });
  const parsed = await readTelegramBotApiCallResult(response);
  if (!parsed.ok) return parsed;

  const filePath = (parsed.result as { file_path?: unknown } | null)?.file_path;
  if (typeof filePath !== "string" || !filePath.trim()) {
    return {
      ok: false,
      status: parsed.status,
      detail: parsed.detail,
      description: "Missing file path in getFile response.",
    };
  }
  return { ok: true, filePath: filePath.trim() };
}

async function readTelegramBotApiCallResult(response: Response): Promise<TelegramBotApiCallResult> {
  const detail = await response.text().catch(() => "");
  const payload = parseTelegramBotApiPayload(detail);
  if (response.ok && payload.ok) {
    return {
      ok: true,
      status: response.status,
      detail,
      result: payload.result,
    };
  }
  return {
    ok: false,
    status: response.status,
    detail,
    ...(payload.description ? { description: payload.description } : {}),
    result: payload.result,
  };
}

function parseTelegramBotApiPayload(detail: string): {
  ok: boolean;
  description?: string;
  result?: unknown;
} {
  const trimmed = detail.trim();
  if (!trimmed) return { ok: false };
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown; description?: unknown; result?: unknown } | null;
    const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
    return {
      ok: parsed?.ok === true,
      ...(description ? { description } : {}),
      result: parsed?.result,
    };
  } catch {
    const description = tryParseTelegramErrorDescription(trimmed);
    return { ok: false, ...(description ? { description } : {}) };
  }
}

function telegramFileNameFromPath(filePath: string): string {
  const normalized = filePath.trim();
  if (!normalized) return "workspace-photo.jpg";
  const parts = normalized.split("/");
  const candidate = parts.at(-1)?.trim() ?? "";
  return candidate || "workspace-photo.jpg";
}

export async function safePromoteTelegramChatMember(params: { botToken: string; chatId: number; userId: number; logger: Logger }): Promise<
  | { ok: true; attempt: "full" | "limited" | "minimal" }
  | {
      ok: false;
      error: string;
    }
> {
  const describeBotPermissionsForPromotionFailure = async (): Promise<void> => {
    const botUserId = parseOptionalPositiveInt(getTelegramBotId(params.botToken));
    if (!botUserId) return;

    const snapshot = await safeFetchTelegramChatMemberSnapshot({
      botToken: params.botToken,
      chatId: params.chatId,
      userId: botUserId,
    });

    if (snapshot.ok) {
      params.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          botUserId,
          botStatus: snapshot.snapshot.status,
          botCanPromoteMembers: snapshot.snapshot.can_promote_members,
          botMember: snapshot.snapshot,
        },
        "Telegram bot admin rights snapshot (promotion failed)"
      );
      return;
    }

    params.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        botUserId,
        status: snapshot.status,
        ...(snapshot.description ? { description: snapshot.description } : {}),
        ...(snapshot.detail ? { detail: snapshot.detail } : {}),
      },
      "Failed to inspect Telegram bot admin rights (promotion failed)"
    );
  };

  try {
    const url = `https://api.telegram.org/bot${params.botToken}/promoteChatMember`;

    const payloads: Array<{
      label: "full" | "limited" | "minimal";
      body: Record<string, unknown>;
    }> = [
      {
        label: "full",
        body: {
          chat_id: params.chatId,
          user_id: params.userId,
          can_manage_topics: true,
          can_invite_users: true,
          can_pin_messages: true,
          can_change_info: true,
          can_manage_chat: true,
          can_delete_messages: true,
          can_restrict_members: true,
          can_promote_members: true,
          can_manage_video_chats: true,
          is_anonymous: false,
        },
      },
      {
        label: "limited",
        body: {
          chat_id: params.chatId,
          user_id: params.userId,
          can_manage_topics: true,
          can_invite_users: true,
          can_pin_messages: true,
          can_change_info: true,
          can_delete_messages: true,
          is_anonymous: false,
        },
      },
      {
        label: "minimal",
        body: {
          chat_id: params.chatId,
          user_id: params.userId,
          can_manage_topics: true,
          can_invite_users: true,
          can_pin_messages: true,
          can_change_info: true,
          is_anonymous: false,
        },
      },
    ];

    let lastStatus: number | undefined;
    let lastDetail = "";
    let lastDescription: string | null = null;

    for (const payload of payloads) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.body),
      });

      if (response.ok) {
        return { ok: true, attempt: payload.label };
      }

      lastStatus = response.status;
      lastDetail = await response.text().catch(() => "");
      lastDescription = tryParseTelegramErrorDescription(lastDetail);

      params.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          status: response.status,
          detail: lastDetail,
          ...(lastDescription ? { description: lastDescription } : {}),
          attempt: payload.label,
        },
        "Failed to promote Telegram chat member"
      );

      const normalizedDescription = (lastDescription ?? "").toLowerCase();
      const isRightsError =
        normalizedDescription.includes("right_forbidden") ||
        normalizedDescription.includes(TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION) ||
        normalizedDescription.includes("chat_admin_required");
      const shouldRetry = isRightsError && payload.label !== "minimal";
      if (!shouldRetry) {
        break;
      }
    }

    await describeBotPermissionsForPromotionFailure();

    if (lastDescription) {
      const normalized = lastDescription.toLowerCase();
      if (normalized.includes(TELEGRAM_BOT_NOT_MEMBER_DESCRIPTION)) {
        return {
          ok: false,
          error: "Couldn't promote you to admin because the bot isn't a member of this group.",
        };
      }
      if (
        normalized.includes("right_forbidden") ||
        normalized.includes(TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION) ||
        normalized.includes("chat_admin_required")
      ) {
        return {
          ok: false,
          error:
            "Couldn't promote you to admin because the bot doesn't have permission to add administrators in this group. Promote the bot to admin and enable the “Add Admins” permission.",
        };
      }
      return {
        ok: false,
        error: `Couldn't promote you to admin: ${lastDescription}`,
      };
    }

    return {
      ok: false,
      error: lastStatus ? `Couldn't promote you to admin (status ${lastStatus}).` : "Couldn't promote you to admin.",
    };
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to promote Telegram chat member");
    await describeBotPermissionsForPromotionFailure();
    return { ok: false, error: "Couldn't promote you to admin." };
  }
}

type TelegramChatMemberSnapshot = {
  status?: string;
  can_manage_chat?: boolean;
  can_manage_topics?: boolean;
  can_invite_users?: boolean;
  can_pin_messages?: boolean;
  can_change_info?: boolean;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
  can_promote_members?: boolean;
  can_manage_video_chats?: boolean;
  is_anonymous?: boolean;
};

async function safeFetchTelegramChatMemberSnapshot(params: { botToken: string; chatId: number; userId: number }): Promise<
  | { ok: true; snapshot: TelegramChatMemberSnapshot }
  | {
      ok: false;
      status?: number;
      description?: string;
      detail?: string;
    }
> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/getChatMember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        user_id: params.userId,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const description = tryParseTelegramErrorDescription(detail);
      return {
        ok: false,
        status: response.status,
        ...(description ? { description } : {}),
        ...(detail ? { detail } : {}),
      };
    }

    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
    } | null;
    const result = data?.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return { ok: false, detail: "Missing chat member result payload." };
    }

    const record = result as Record<string, unknown>;
    const snapshot: TelegramChatMemberSnapshot = {};
    const status = record.status;
    if (typeof status === "string" && status.trim()) {
      snapshot.status = status.trim();
    }
    for (const key of [
      "can_manage_chat",
      "can_manage_topics",
      "can_invite_users",
      "can_pin_messages",
      "can_change_info",
      "can_delete_messages",
      "can_restrict_members",
      "can_promote_members",
      "can_manage_video_chats",
      "is_anonymous",
    ] as const) {
      const value = record[key];
      if (typeof value === "boolean") {
        snapshot[key] = value;
      }
    }

    return { ok: true, snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Failed to fetch chat member: ${message}` };
  }
}

export async function safeGetTelegramChatMemberCount(params: { botToken: string; chatId: number; logger: Logger }): Promise<number | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/getChatMemberCount`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: params.chatId }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.warn({ status: response.status, detail }, "Failed to fetch Telegram chat member count");
      return null;
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
    } | null;
    const count = data?.result;
    if (typeof count !== "number" || !Number.isFinite(count)) return null;
    const normalized = Math.trunc(count);
    return normalized >= 0 ? normalized : null;
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to fetch Telegram chat member count");
    return null;
  }
}

export async function safeLeaveTelegramChat(params: { botToken: string; chatId: number; logger: Logger }): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/leaveChat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: params.chatId }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.warn({ status: response.status, detail }, "Failed to leave Telegram chat");
    }
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to leave Telegram chat");
  }
}

export async function handleTelegramMyChatMemberUpdate(params: { botToken: string; update: TelegramChatMemberUpdated; logger: Logger }): Promise<void> {
  const chatId = typeof params.update.chat?.id === "number" ? params.update.chat.id : null;
  if (!chatId || !Number.isFinite(chatId)) return;

  const newStatus = params.update.new_chat_member?.status?.trim().toLowerCase() ?? "";
  if (newStatus !== "kicked" && newStatus !== "left") return;

  // my_chat_member updates should always refer to the current bot, but verify best-effort when possible.
  const botIdStr = getTelegramBotId(params.botToken);
  const botId = Number.parseInt(botIdStr, 10);
  const updateBotId = params.update.new_chat_member?.user?.id;
  if (Number.isFinite(botId) && typeof updateBotId === "number" && updateBotId !== botId) {
    return;
  }

  const kv = await getTelegramKv(params.logger);
  if (!kv) return;

  // Best-effort cleanup: remove any workspace bootstrap / claim mappings tied to this chat.
  const botTokenId = botIdStr || "unknown";
  const pending = await loadTelegramWorkspaceBootstrapByChat({
    kv,
    botId: botTokenId,
    chatId,
    logger: params.logger,
  });
  if (pending) {
    await deleteTelegramWorkspaceBootstrap({
      kv,
      botId: botTokenId,
      userId: pending.userId,
      chatId,
      logger: params.logger,
    });
  }

  const workspace = await loadTelegramWorkspaceByChat({
    kv,
    botId: botTokenId,
    chatId,
    logger: params.logger,
  });
  if (workspace) {
    const unclaimed = await unclaimTelegramWorkspace({
      kv,
      botId: botTokenId,
      userId: workspace.userId,
      logger: params.logger,
    });
    if (!unclaimed.ok) {
      params.logger.warn(
        {
          chatId,
          userId: workspace.userId,
          error: unclaimed.error,
        },
        "Failed to unclaim Telegram workspace after bot removal"
      );
    }
  }

  await deleteTelegramRoutingOverridesForChat({
    kv,
    botId: botTokenId,
    chatId,
    logger: params.logger,
  });
}
