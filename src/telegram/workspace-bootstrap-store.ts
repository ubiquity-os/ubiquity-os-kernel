import type { KvKey, KvLike, LoggerLike } from "../github/utils/kv-client.ts";

export type TelegramWorkspaceBootstrapByUserRecord = Readonly<{
  chatId: number;
  inviteLink?: string;
  createdAt?: string;
  expiresAtMs?: number;
}>;

export type TelegramWorkspaceBootstrapByChatRecord = Readonly<{
  userId: number;
  inviteLink?: string;
  createdAt?: string;
  expiresAtMs?: number;
}>;

const TELEGRAM_WORKSPACE_BOOTSTRAP_PREFIX: KvKey = ["ubiquityos", "telegram", "workspace", "bootstrap"];

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

function parseOptionalEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function buildTelegramWorkspaceBootstrapByUserKey(botId: string, userId: number): KvKey {
  return [...TELEGRAM_WORKSPACE_BOOTSTRAP_PREFIX, "by-user", botId, String(userId)];
}

function buildTelegramWorkspaceBootstrapByChatKey(botId: string, chatId: number): KvKey {
  return [...TELEGRAM_WORKSPACE_BOOTSTRAP_PREFIX, "by-chat", botId, String(chatId)];
}

function parseTelegramWorkspaceBootstrapByUserRecord(value: unknown): TelegramWorkspaceBootstrapByUserRecord | null {
  if (!isRecord(value)) return null;
  const chatId = parseNonZeroInt(value.chatId);
  if (!chatId) return null;
  const inviteLink = normalizeOptionalString(value.inviteLink);
  const createdAt = normalizeOptionalString(value.createdAt);
  const expiresAtMs = parseOptionalEpochMs(value.expiresAtMs);
  return {
    chatId,
    ...(inviteLink ? { inviteLink } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(expiresAtMs ? { expiresAtMs } : {}),
  };
}

function parseTelegramWorkspaceBootstrapByChatRecord(value: unknown): TelegramWorkspaceBootstrapByChatRecord | null {
  if (!isRecord(value)) return null;
  const userId = parsePositiveInt(value.userId);
  if (!userId) return null;
  const inviteLink = normalizeOptionalString(value.inviteLink);
  const createdAt = normalizeOptionalString(value.createdAt);
  const expiresAtMs = parseOptionalEpochMs(value.expiresAtMs);
  return {
    userId,
    ...(inviteLink ? { inviteLink } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(expiresAtMs ? { expiresAtMs } : {}),
  };
}

function isExpired(expiresAtMs?: number, nowMs?: number): boolean {
  if (!expiresAtMs) return false;
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  return expiresAtMs <= now;
}

async function clearTelegramWorkspaceBootstrap(params: { kv: KvLike; botId: string; userId: number; chatId: number; logger?: LoggerLike }): Promise<void> {
  const byUserKey = buildTelegramWorkspaceBootstrapByUserKey(params.botId, params.userId);
  const byChatKey = buildTelegramWorkspaceBootstrapByChatKey(params.botId, params.chatId);
  const atomic = params.kv.atomic?.();
  if (atomic) {
    try {
      await atomic.delete(byUserKey).delete(byChatKey).commit();
      return;
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to clear Telegram workspace bootstrap record (atomic).");
    }
  }
  if (typeof params.kv.delete === "function") {
    try {
      await params.kv.delete(byUserKey);
      await params.kv.delete(byChatKey);
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to clear Telegram workspace bootstrap record.");
    }
  }
}

export async function loadTelegramWorkspaceBootstrapByUser(params: {
  kv: KvLike;
  botId: string;
  userId: number;
  logger?: LoggerLike;
  nowMs?: number;
}): Promise<TelegramWorkspaceBootstrapByUserRecord | null> {
  const key = buildTelegramWorkspaceBootstrapByUserKey(params.botId, params.userId);
  try {
    const { value } = await params.kv.get(key);
    const parsed = parseTelegramWorkspaceBootstrapByUserRecord(value);
    if (!parsed) return null;
    if (isExpired(parsed.expiresAtMs, params.nowMs)) {
      await clearTelegramWorkspaceBootstrap({ kv: params.kv, botId: params.botId, userId: params.userId, chatId: parsed.chatId, logger: params.logger });
      return null;
    }
    return parsed;
  } catch (error) {
    params.logger?.warn?.({ err: error, key }, "Failed to load Telegram workspace bootstrap record (by user).");
    return null;
  }
}

export async function loadTelegramWorkspaceBootstrapByChat(params: {
  kv: KvLike;
  botId: string;
  chatId: number;
  logger?: LoggerLike;
  nowMs?: number;
}): Promise<TelegramWorkspaceBootstrapByChatRecord | null> {
  const key = buildTelegramWorkspaceBootstrapByChatKey(params.botId, params.chatId);
  try {
    const { value } = await params.kv.get(key);
    const parsed = parseTelegramWorkspaceBootstrapByChatRecord(value);
    if (!parsed) return null;
    if (isExpired(parsed.expiresAtMs, params.nowMs)) {
      await clearTelegramWorkspaceBootstrap({ kv: params.kv, botId: params.botId, userId: parsed.userId, chatId: params.chatId, logger: params.logger });
      return null;
    }
    return parsed;
  } catch (error) {
    params.logger?.warn?.({ err: error, key }, "Failed to load Telegram workspace bootstrap record (by chat).");
    return null;
  }
}

export async function saveTelegramWorkspaceBootstrap(params: {
  kv: KvLike;
  botId: string;
  userId: number;
  chatId: number;
  inviteLink: string;
  ttlMs: number;
  logger?: LoggerLike;
  now?: () => { nowIso: string; nowMs: number };
}): Promise<{ ok: true; record: TelegramWorkspaceBootstrapByUserRecord } | { ok: false; error: string }> {
  const ttlMs = Math.trunc(params.ttlMs);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { ok: false, error: "Invalid bootstrap TTL." };
  }

  const { nowIso, nowMs } = (params.now ?? (() => ({ nowIso: new Date().toISOString(), nowMs: Date.now() })))();
  const expiresAtMs = nowMs + ttlMs;

  const byUserKey = buildTelegramWorkspaceBootstrapByUserKey(params.botId, params.userId);
  const byChatKey = buildTelegramWorkspaceBootstrapByChatKey(params.botId, params.chatId);

  const byUserRecord = {
    chatId: params.chatId,
    inviteLink: params.inviteLink,
    createdAt: nowIso,
    expiresAtMs,
  };
  const byChatRecord = {
    userId: params.userId,
    inviteLink: params.inviteLink,
    createdAt: nowIso,
    expiresAtMs,
  };

  const atomic = params.kv.atomic?.();
  if (atomic) {
    try {
      const commit = await atomic.set(byUserKey, byUserRecord, { expireIn: ttlMs }).set(byChatKey, byChatRecord, { expireIn: ttlMs }).commit();
      if (!commit.ok) {
        return { ok: false, error: "Failed to persist workspace bootstrap mapping (conflict)." };
      }
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to atomically persist Telegram workspace bootstrap mapping.");
      return { ok: false, error: "Failed to persist workspace bootstrap mapping." };
    }
  } else {
    try {
      await params.kv.set(byUserKey, byUserRecord, { expireIn: ttlMs });
      await params.kv.set(byChatKey, byChatRecord, { expireIn: ttlMs });
    } catch (error) {
      params.logger?.warn?.({ err: error }, "Failed to persist Telegram workspace bootstrap mapping.");
      return { ok: false, error: "Failed to persist workspace bootstrap mapping." };
    }
  }

  return {
    ok: true,
    record: { chatId: params.chatId, inviteLink: params.inviteLink, createdAt: nowIso, expiresAtMs },
  };
}

export async function deleteTelegramWorkspaceBootstrap(params: {
  kv: KvLike;
  botId: string;
  userId: number;
  chatId: number;
  logger?: LoggerLike;
}): Promise<void> {
  await clearTelegramWorkspaceBootstrap(params);
}
