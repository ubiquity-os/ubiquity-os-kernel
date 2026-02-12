import { normalizeLogin } from "./normalization.ts";
import { TELEGRAM_SESSION_BODY_MAX_CHARS, TELEGRAM_SESSION_TITLE_MAX_CHARS, type TelegramChat, type TelegramMessage } from "./handler-shared.ts";

export function clampText(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeTelegramHtmlAttribute(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

export function formatHelpForTelegram(commands: Array<{ name: string; description: string; example: string }>): string {
  if (!commands.length) {
    return "<b>Available Commands</b>\nNo commands available.";
  }
  const lines = ["<b>Available Commands</b>"];
  for (const command of commands) {
    const description = command.description?.trim() ?? "";
    const example = command.example?.trim() ?? "";
    const label = `/${command.name}`;
    const escapedLabel = escapeTelegramHtml(label);
    const escapedDescription = escapeTelegramHtml(description);
    const normalizedExample = example && example.startsWith("/") ? example : "";
    const escapedExample = normalizedExample ? escapeTelegramHtml(normalizedExample) : "";
    const exampleSuffix = escapedExample && escapedExample !== escapedLabel ? `\n<code>Example: ${escapedExample}</code>` : "";
    lines.push(`• <code>${escapedLabel}</code> — ${escapedDescription}${exampleSuffix}`.trim());
  }
  lines.push("");
  lines.push("<code>@ubiquityos &lt;request&gt;</code> — Run the full-power agent to handle complex requests.");
  return lines.join("\n");
}

export function getTelegramAuthor(message: TelegramMessage): string {
  const user = message.from;
  if (user?.username) {
    const normalized = normalizeLogin(user.username);
    if (normalized) return normalized;
  }
  if (typeof user?.id === "number") {
    return `telegram_${user.id}`;
  }
  return "telegram_user";
}

export function formatTelegramChatLabel(chat: TelegramChat): string {
  const title = chat.title?.trim() ?? "";
  if (title) return title;
  const username = chat.username?.trim() ?? "";
  if (username) return `@${username}`;
  return `chat ${chat.id}`;
}

export function buildTelegramSessionIssueTitle(author: string, chatLabel: string): string {
  const base = `Telegram session: @${author} (${chatLabel})`;
  return clampText(base, TELEGRAM_SESSION_TITLE_MAX_CHARS);
}

export function buildTelegramSessionIssueBody(params: {
  author: string;
  chatLabel: string;
  chatId: number;
  threadId?: number;
  messageId: number;
  sourceUrl?: string;
  rawText: string;
}): string {
  const bodyLines = [
    "Telegram ingress session.",
    `Chat: ${params.chatLabel} (${params.chatId}).`,
    params.threadId ? `Topic: ${params.threadId}.` : null,
    `User: @${params.author}.`,
    `Message: ${params.messageId}.`,
    params.sourceUrl ? `Context: ${params.sourceUrl}` : null,
    "",
    "Initial message:",
    params.rawText.trim() || "(empty)",
  ].filter(Boolean);
  return clampText(bodyLines.join("\n"), TELEGRAM_SESSION_BODY_MAX_CHARS);
}
