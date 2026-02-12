import { type Env } from "../github/types/env.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { TELEGRAM_GENERAL_TOPIC_ID } from "./api-client.ts";
import {
  type TelegramCallbackQuery,
  type TelegramChat,
  type TelegramChatMemberUpdated,
  type TelegramMessage,
  type TelegramSecretsConfig,
  type TelegramUpdate,
} from "./handler-shared.ts";
import { normalizeOptionalString, parseOptionalPositiveInt } from "./normalization.ts";

export function getTelegramCallbackQuery(update: TelegramUpdate): TelegramCallbackQuery | null {
  return update.callback_query ?? null;
}

export function getTelegramMyChatMemberUpdate(update: TelegramUpdate): TelegramChatMemberUpdated | null {
  return update.my_chat_member ?? null;
}

export function getTelegramChatMemberUpdate(update: TelegramUpdate): TelegramChatMemberUpdated | null {
  return update.chat_member ?? null;
}

export function getTelegramMessage(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.edited_message ?? null;
}

export function getTelegramText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

export function getClassificationText(rawText: string, chat: TelegramChat): string {
  const trimmed = rawText.trim();
  if (!trimmed) return trimmed;
  if (chat.type !== "private") return trimmed;
  if (trimmed.startsWith("/") || trimmed.startsWith("@")) return trimmed;
  // Treat private chats as implicit @ubiquityos.
  return `@ubiquityos ${trimmed}`;
}

export function resolveTelegramForumThreadId(params: { isForum?: boolean; messageThreadId?: number | null }): number | null {
  if (params.isForum && params.messageThreadId == null) {
    return TELEGRAM_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId ?? null;
}

function normalizeOptionalEnvValue(value?: string): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : undefined;
}

export function parseTelegramSecretsConfig(env: Env):
  | { ok: true; config: TelegramSecretsConfig }
  | {
      ok: false;
      status: ContentfulStatusCode;
      error: string;
    } {
  const raw = normalizeOptionalEnvValue(env.UOS_TELEGRAM);
  if (!raw) {
    return { ok: false, status: 404, error: "Telegram ingress disabled." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, status: 500, error: "Invalid UOS_TELEGRAM JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 500, error: "Invalid UOS_TELEGRAM config." };
  }
  const record = parsed as Record<string, unknown>;
  const botToken = normalizeOptionalString(record.botToken);
  if (!botToken) {
    return {
      ok: false,
      status: 500,
      error: "UOS_TELEGRAM.botToken is required.",
    };
  }
  const webhookSecret = normalizeOptionalString(record.webhookSecret);
  const apiId = parseOptionalPositiveInt(record.apiId);
  const apiHash = normalizeOptionalString(record.apiHash);
  const userSession = normalizeOptionalString(record.userSession);
  const workspacePhotoFileId = normalizeOptionalString(record.workspacePhotoFileId);
  return {
    ok: true,
    config: {
      botToken,
      webhookSecret,
      ...(apiId ? { apiId } : {}),
      ...(apiHash ? { apiHash } : {}),
      ...(userSession ? { userSession } : {}),
      ...(workspacePhotoFileId ? { workspacePhotoFileId } : {}),
    },
  };
}
