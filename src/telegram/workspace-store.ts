import type { KvKey, KvLike, LoggerLike } from "../github/utils/kv-client.ts";

export type TelegramWorkspaceByUserRecord = Readonly<{
  chatId: number;
  claimedAt?: string;
}>;

export type TelegramWorkspaceByChatRecord = Readonly<{
  userId: number;
  claimedAt?: string;
}>;

export type ClaimTelegramWorkspaceResult =
  | {
      ok: true;
      changed: boolean;
      record: Readonly<{ userId: number; chatId: number; claimedAt: string }>;
    }
  | {
      ok: false;
      error: string;
    };

export type UnclaimTelegramWorkspaceResult =
  | { ok: true; removed: boolean; chatId?: number }
  | {
      ok: false;
      error: string;
    };

const TELEGRAM_WORKSPACE_PREFIX: KvKey = ["ubiquityos", "telegram", "workspace"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parseNonZeroInt(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized !== 0 ? normalized : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
  }
  return null;
}

function buildTelegramWorkspaceByUserKey(botId: string, userId: number): KvKey {
  return [...TELEGRAM_WORKSPACE_PREFIX, "by-user", botId, String(userId)];
}

function buildTelegramWorkspaceByChatKey(botId: string, chatId: number): KvKey {
  return [...TELEGRAM_WORKSPACE_PREFIX, "by-chat", botId, String(chatId)];
}

function parseTelegramWorkspaceByUserRecord(value: unknown): TelegramWorkspaceByUserRecord | null {
  if (!isRecord(value)) return null;
  const chatId = parseNonZeroInt(value.chatId);
  if (!chatId) return null;
  const claimedAt = normalizeOptionalString(value.claimedAt);
  return { chatId, ...(claimedAt ? { claimedAt } : {}) };
}

function parseTelegramWorkspaceByChatRecord(value: unknown): TelegramWorkspaceByChatRecord | null {
  if (!isRecord(value)) return null;
  const userId = parsePositiveInt(value.userId);
  if (!userId) return null;
  const claimedAt = normalizeOptionalString(value.claimedAt);
  return { userId, ...(claimedAt ? { claimedAt } : {}) };
}

export async function loadTelegramWorkspaceByUser(params: {
  kv: KvLike;
  botId: string;
  userId: number;
  logger?: LoggerLike;
}): Promise<TelegramWorkspaceByUserRecord | null> {
  const key = buildTelegramWorkspaceByUserKey(params.botId, params.userId);
  try {
    const { value } = await params.kv.get(key);
    return parseTelegramWorkspaceByUserRecord(value);
  } catch (error) {
    params.logger?.warn?.({ err: error, key }, "Failed to load Telegram workspace mapping (by user).");
    return null;
  }
}

export async function loadTelegramWorkspaceByChat(params: {
  kv: KvLike;
  botId: string;
  chatId: number;
  logger?: LoggerLike;
}): Promise<TelegramWorkspaceByChatRecord | null> {
  const key = buildTelegramWorkspaceByChatKey(params.botId, params.chatId);
  try {
    const { value } = await params.kv.get(key);
    return parseTelegramWorkspaceByChatRecord(value);
  } catch (error) {
    params.logger?.warn?.({ err: error, key }, "Failed to load Telegram workspace mapping (by chat).");
    return null;
  }
}

export async function claimTelegramWorkspace(params: {
  kv: KvLike;
  botId: string;
  userId: number;
  chatId: number;
  logger?: LoggerLike;
  now?: () => string;
}): Promise<ClaimTelegramWorkspaceResult> {
  const nowIso = (params.now ?? (() => new Date().toISOString()))();
  const userKey = buildTelegramWorkspaceByUserKey(params.botId, params.userId);
  const chatKey = buildTelegramWorkspaceByChatKey(params.botId, params.chatId);

  let userEntry: { value: unknown; versionstamp?: string | null };
  let chatEntry: { value: unknown; versionstamp?: string | null };
  try {
    userEntry = await params.kv.get(userKey);
    chatEntry = await params.kv.get(chatKey);
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Failed to read Telegram workspace mapping.");
    return { ok: false, error: "Failed to read workspace mapping." };
  }

  const existingByUser = parseTelegramWorkspaceByUserRecord(userEntry.value);
  const existingByChat = parseTelegramWorkspaceByChatRecord(chatEntry.value);

  if (existingByChat && existingByChat.userId !== params.userId) {
    return { ok: false, error: "This group is already claimed by another user." };
  }

  if (existingByUser && existingByUser.chatId !== params.chatId) {
    return { ok: false, error: "You already claimed a different group. Delete/leave it first." };
  }

  const isAlready = existingByUser?.chatId === params.chatId && existingByChat?.userId === params.userId;
  if (isAlready) {
    return {
      ok: true,
      changed: false,
      record: { userId: params.userId, chatId: params.chatId, claimedAt: existingByUser?.claimedAt ?? nowIso },
    };
  }

  const atomic = params.kv.atomic?.();
  if (atomic) {
    try {
      const commit = await atomic
        .check({ key: userKey, versionstamp: userEntry.versionstamp ?? null })
        .check({ key: chatKey, versionstamp: chatEntry.versionstamp ?? null })
        .set(userKey, { chatId: params.chatId, claimedAt: nowIso })
        .set(chatKey, { userId: params.userId, claimedAt: nowIso })
        .commit();
      if (!commit.ok) {
        return { ok: false, error: "Workspace claim conflicted; try again." };
      }
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to atomically claim Telegram workspace.");
      return { ok: false, error: "Failed to claim workspace." };
    }
  } else {
    try {
      await params.kv.set(userKey, { chatId: params.chatId, claimedAt: nowIso });
      await params.kv.set(chatKey, { userId: params.userId, claimedAt: nowIso });
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to claim Telegram workspace.");
      return { ok: false, error: "Failed to claim workspace." };
    }
  }

  return { ok: true, changed: true, record: { userId: params.userId, chatId: params.chatId, claimedAt: nowIso } };
}

export async function unclaimTelegramWorkspace(params: {
  kv: KvLike;
  botId: string;
  userId: number;
  logger?: LoggerLike;
}): Promise<UnclaimTelegramWorkspaceResult> {
  const userKey = buildTelegramWorkspaceByUserKey(params.botId, params.userId);

  let userEntry: { value: unknown; versionstamp?: string | null };
  try {
    userEntry = await params.kv.get(userKey);
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Failed to load Telegram workspace mapping for unclaim.");
    return { ok: false, error: "Failed to load workspace mapping." };
  }

  const existingByUser = parseTelegramWorkspaceByUserRecord(userEntry.value);
  if (!existingByUser) {
    return { ok: true, removed: false };
  }

  const chatKey = buildTelegramWorkspaceByChatKey(params.botId, existingByUser.chatId);
  let chatEntry: { value: unknown; versionstamp?: string | null } = { value: null, versionstamp: null };
  try {
    chatEntry = await params.kv.get(chatKey);
  } catch (error) {
    params.logger?.warn?.({ err: error }, "Failed to load Telegram workspace reverse mapping for unclaim.");
  }
  const existingByChat = parseTelegramWorkspaceByChatRecord(chatEntry.value);
  const shouldDeleteChatKey = existingByChat?.userId === params.userId;

  const atomic = params.kv.atomic?.();
  if (atomic) {
    try {
      let op = atomic.check({ key: userKey, versionstamp: userEntry.versionstamp ?? null });
      if (shouldDeleteChatKey) {
        op = op.check({ key: chatKey, versionstamp: chatEntry.versionstamp ?? null });
      }
      op = op.delete(userKey);
      if (shouldDeleteChatKey) {
        op = op.delete(chatKey);
      }
      const commit = await op.commit();
      if (!commit.ok) {
        return { ok: false, error: "Workspace unclaim conflicted; try again." };
      }
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to atomically unclaim Telegram workspace.");
      return { ok: false, error: "Failed to unclaim workspace." };
    }
  } else if (typeof params.kv.delete === "function") {
    try {
      await params.kv.delete(userKey);
      if (shouldDeleteChatKey) {
        await params.kv.delete(chatKey);
      }
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to unclaim Telegram workspace.");
      return { ok: false, error: "Failed to unclaim workspace." };
    }
  } else {
    return { ok: false, error: "KV delete is unavailable; cannot unclaim workspace." };
  }

  return { ok: true, removed: true, chatId: existingByUser.chatId };
}
