import { normalizePositiveInt } from "./normalization.ts";

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
  // Telegram Bot API 9.4+: optional button style (color).
  style?: "danger" | "success" | "primary";
};

export type TelegramReplyMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

export type TelegramChatLike = {
  id: number;
  username?: string;
};

export type TelegramParseMode = "HTML" | "MarkdownV2";

export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "upload_video"
  | "upload_document"
  | "upload_audio"
  | "upload_video_note"
  | "record_video"
  | "record_audio"
  | "choose_sticker"
  | "find_location";

export type TelegramApiLogger = {
  warn: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

export const TELEGRAM_GENERAL_TOPIC_ID = 1;
export const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_TYPING_INTERVAL_MS = 4500;

function buildTelegramThreadParams(messageThreadId?: number): { message_thread_id: number } | null {
  if (messageThreadId == null) return null;
  const normalized = Math.trunc(messageThreadId);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) return null;
  return { message_thread_id: normalized };
}

function buildTypingThreadParams(messageThreadId?: number): { message_thread_id: number } | null {
  if (messageThreadId == null) return null;
  const normalized = Math.trunc(messageThreadId);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return { message_thread_id: normalized };
}

function truncateTelegramMessage(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
  const suffix = "...";
  return text.slice(0, TELEGRAM_MESSAGE_LIMIT - suffix.length) + suffix;
}

export async function safeAnswerTelegramCallbackQuery(params: {
  botToken: string;
  callbackQueryId: string;
  text?: string;
  logger: TelegramApiLogger;
}): Promise<void> {
  const { botToken, callbackQueryId, text, logger } = params;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      }),
    });
    const detail = await response.text().catch(() => "");
    let isOk = response.ok;
    if (isOk) {
      try {
        const parsed = detail ? (JSON.parse(detail) as { ok?: unknown } | null) : null;
        isOk = parsed?.ok === true;
      } catch {
        // ignore
      }
    }
    if (!isOk) {
      logger.warn({ status: response.status, detail }, "Failed to answer Telegram callback query");
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to answer Telegram callback query");
  }
}

export async function safeEditTelegramMessageReplyMarkup(params: {
  botToken: string;
  chatId: number;
  messageId: number;
  replyMarkup?: TelegramReplyMarkup | null;
  logger: TelegramApiLogger;
}): Promise<boolean> {
  const { botToken, chatId, messageId, replyMarkup, logger } = params;
  const normalizedChatId = Math.trunc(chatId);
  const normalizedMessageId = Math.trunc(messageId);
  if (!Number.isFinite(normalizedChatId) || !Number.isFinite(normalizedMessageId) || normalizedMessageId <= 0) {
    return false;
  }

  try {
    const payload: Record<string, unknown> = {
      chat_id: normalizedChatId,
      message_id: normalizedMessageId,
    };
    if (replyMarkup === undefined) {
      payload.reply_markup = { inline_keyboard: [[]] };
    } else {
      payload.reply_markup = replyMarkup;
    }
    const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const detail = await response.text().catch(() => "");
    let isOk = response.ok;
    if (isOk) {
      try {
        const parsed = detail ? (JSON.parse(detail) as { ok?: unknown } | null) : null;
        isOk = parsed?.ok === true;
      } catch {
        // ignore
      }
    }
    if (!isOk) {
      logger.warn({ status: response.status, detail }, "Failed to edit Telegram message reply markup");
      return false;
    }
    return true;
  } catch (error) {
    logger.warn({ err: error }, "Failed to edit Telegram message reply markup");
    return false;
  }
}

export async function safeSendTelegramMessage(params: {
  botToken: string;
  chatId: number;
  messageThreadId?: number;
  replyToMessageId?: number;
  text: string;
  parseMode?: TelegramParseMode;
  disablePreview?: boolean;
  disableNotification?: boolean;
  shouldTruncate?: boolean;
  replyMarkup?: TelegramReplyMarkup;
  logger: TelegramApiLogger;
}): Promise<number | null> {
  const { botToken, chatId, messageThreadId, replyToMessageId, parseMode, disablePreview, disableNotification, shouldTruncate, replyMarkup, logger } = params;
  const errorMessage = "Failed to send Telegram reply";
  const normalized = params.text.trim();
  if (!normalized) return null;
  const shouldTruncateMessage = shouldTruncate !== false;
  const threadParams = buildTelegramThreadParams(messageThreadId);
  const body = {
    chat_id: chatId,
    ...(threadParams ?? {}),
    text: shouldTruncateMessage ? truncateTelegramMessage(normalized) : normalized,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(disablePreview ? { disable_web_page_preview: true } : {}),
    ...(disableNotification ? { disable_notification: true } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const detail = await response.text().catch(() => "");
    if (!response.ok) {
      logger.warn({ status: response.status, detail }, errorMessage);
      return null;
    }
    let data: { ok?: boolean; result?: { message_id?: number } } | null = null;
    try {
      data = detail
        ? (JSON.parse(detail) as {
            ok?: boolean;
            result?: { message_id?: number };
          })
        : null;
    } catch {
      data = null;
    }
    if (data?.ok !== true) {
      logger.warn({ status: response.status, detail }, errorMessage);
      return null;
    }
    return typeof data.result?.message_id === "number" ? data.result.message_id : null;
  } catch (error) {
    logger.warn({ err: error }, errorMessage);
    return null;
  }
}

export async function safeSendTelegramMessageWithFallback(params: Parameters<typeof safeSendTelegramMessage>[0]): Promise<number | null> {
  const first = await safeSendTelegramMessage(params);
  if (first !== null || !params.replyToMessageId) {
    return first;
  }
  return safeSendTelegramMessage({ ...params, replyToMessageId: undefined });
}

export async function safeSendTelegramChatAction(params: {
  botToken: string;
  chatId: number;
  messageThreadId?: number;
  action: TelegramChatAction;
  logger: TelegramApiLogger;
}): Promise<void> {
  const { botToken, chatId, messageThreadId, action, logger } = params;
  const threadParams = buildTypingThreadParams(messageThreadId);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action,
        ...(threadParams ?? {}),
      }),
    });
    const detail = await response.text().catch(() => "");
    let isOk = response.ok;
    if (isOk) {
      try {
        const parsed = detail ? (JSON.parse(detail) as { ok?: unknown } | null) : null;
        isOk = parsed?.ok === true;
      } catch {
        // ignore
      }
    }
    if (!isOk) {
      logger.warn({ status: response.status, detail }, "Failed to send Telegram chat action");
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to send Telegram chat action");
  }
}

export function startTelegramChatActionLoop(params: {
  botToken: string;
  chatId: number;
  messageThreadId?: number;
  action: TelegramChatAction;
  intervalMs?: number;
  logger: TelegramApiLogger;
}): () => void {
  const intervalMs =
    typeof params.intervalMs === "number" && Number.isFinite(params.intervalMs) ? Math.max(1000, Math.trunc(params.intervalMs)) : TELEGRAM_TYPING_INTERVAL_MS;

  void safeSendTelegramChatAction(params);

  const interval = setInterval(() => {
    void safeSendTelegramChatAction(params);
  }, intervalMs);

  return () => clearInterval(interval);
}

export function tryBuildTelegramMessageLink(chat: TelegramChatLike, messageId: number): string | null {
  const normalizedMessageId = normalizePositiveInt(messageId);
  if (!normalizedMessageId) return null;

  const username = chat.username?.trim() ?? "";
  if (username) {
    return `https://t.me/${encodeURIComponent(username)}/${normalizedMessageId}`;
  }

  const chatId = Math.trunc(chat.id);
  if (!Number.isFinite(chatId)) return null;
  const chatIdStr = String(chatId);
  if (!chatIdStr.startsWith("-100")) return null;
  const internalId = chatIdStr.slice("-100".length);
  if (!internalId || !/^[0-9]+$/.test(internalId)) return null;
  return `https://t.me/c/${internalId}/${normalizedMessageId}`;
}

export async function safePinTelegramMessage(params: { botToken: string; chatId: number; messageId: number | null; logger: TelegramApiLogger }): Promise<void> {
  if (!params.messageId) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/pinChatMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        message_id: params.messageId,
        disable_notification: true,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.debug({ status: response.status, detail }, "Failed to pin Telegram message");
    }
  } catch (error) {
    params.logger.debug({ err: error }, "Failed to pin Telegram message");
  }
}
