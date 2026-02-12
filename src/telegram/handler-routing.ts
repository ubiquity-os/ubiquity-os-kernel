import { getKvClient, type KvKey, type KvLike } from "../github/utils/kv-client.ts";
import {
  safePinTelegramMessage,
  safeSendTelegramMessage,
  TELEGRAM_GENERAL_TOPIC_ID,
  type TelegramReplyMarkup,
  tryBuildTelegramMessageLink,
} from "./api-client.ts";
import { buildTelegramAgentPlanningKey, loadTelegramAgentPlanningSession } from "./agent-planning.ts";
import {
  buildTelegramRoutingOverride,
  describeTelegramContext,
  describeTelegramContextLabel,
  formatRoutingLabel,
  isSameTelegramRoutingOverride,
  parseGithubContextFromText,
  parseTelegramRoutingOverride,
  type TelegramRoutingConfig,
  type TelegramRoutingOverride,
} from "./routing-context.ts";
import { loadTelegramWorkspaceByChat } from "./workspace-store.ts";
import { parseOptionalPositiveInt } from "./normalization.ts";
import {
  type Logger,
  TELEGRAM_COMMAND_SYNC_MIN_INTERVAL_MS,
  TELEGRAM_CONTEXT_PREFIX,
  TELEGRAM_CONTEXT_SAVE_ERROR,
  TELEGRAM_FORUM_TOPIC_CREATE_ERROR,
  TELEGRAM_FORUM_TOPIC_NAME_MAX_CHARS,
  TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION,
  TELEGRAM_SHIM_COMMANDS,
  type TelegramChat,
  telegramCommandSyncState,
  telegramKvState,
} from "./handler-shared.ts";

function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeTelegramHtmlAttribute(text: string): string {
  return escapeTelegramHtml(text).replaceAll('"', "&quot;");
}

export function clampTelegramTopicName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "UbiquityOS topic";
  if (trimmed.length <= TELEGRAM_FORUM_TOPIC_NAME_MAX_CHARS) return trimmed;
  const suffix = "...";
  return trimmed.slice(0, TELEGRAM_FORUM_TOPIC_NAME_MAX_CHARS - suffix.length) + suffix;
}

export async function safeCreateTelegramForumTopic(params: {
  botToken: string;
  chatId: number;
  name: string;
  logger: Logger;
}): Promise<{ ok: true; threadId: number; name: string } | { ok: false; error: string }> {
  const name = clampTelegramTopicName(params.name);
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/createForumTopic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: params.chatId, name }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.warn({ status: response.status, detail }, "Failed to create Telegram forum topic");
      const hint = detail.toLowerCase().includes(TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION)
        ? " Promote the bot to an admin with Manage Topics permission."
        : "";
      return { ok: false, error: `Couldn't create a topic.${hint}`.trim() };
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_thread_id?: number; name?: string };
    } | null;
    const rawThreadId = data?.result?.message_thread_id;
    if (typeof rawThreadId !== "number" || !Number.isFinite(rawThreadId)) {
      return { ok: false, error: TELEGRAM_FORUM_TOPIC_CREATE_ERROR };
    }
    const threadId = Math.trunc(rawThreadId);
    if (threadId <= 0) {
      return { ok: false, error: TELEGRAM_FORUM_TOPIC_CREATE_ERROR };
    }
    return { ok: true, threadId, name: data?.result?.name?.trim() || name };
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to create Telegram forum topic");
    return { ok: false, error: TELEGRAM_FORUM_TOPIC_CREATE_ERROR };
  }
}

export async function handleTelegramTopicCommand(params: {
  botToken: string;
  chat: TelegramChat;
  replyToMessageId: number;
  messageThreadId: number | null;
  rawArgs: string;
  allowOverride: boolean;
  logger: Logger;
}): Promise<boolean> {
  if (!params.allowOverride) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: "Topic contexts are only available in shim mode.",
      logger: params.logger,
    });
    return true;
  }

  if (params.chat.type === "private") {
    return await handleTelegramContextCommand({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      rawArgs: params.rawArgs,
      allowOverride: params.allowOverride,
      logger: params.logger,
    });
  }

  if (params.chat.is_forum !== true) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: "This group doesn't have Topics enabled. Enable Topics (forum) and try again.",
      logger: params.logger,
    });
    return true;
  }

  const kv = await getTelegramKv(params.logger);
  if (!kv) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: "KV is unavailable, so I can't persist topic context yet.",
      logger: params.logger,
    });
    return true;
  }

  const botId = getTelegramBotId(params.botToken);
  const workspace = await loadTelegramWorkspaceByChat({
    kv,
    botId,
    chatId: params.chat.id,
    logger: params.logger,
  });
  if (!workspace) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: "This group isn't a workspace. DM me /workspace to create one.",
      logger: params.logger,
    });
    return true;
  }

  const rawArgs = params.rawArgs.trim();
  if (!rawArgs) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: "Usage: /topic https://github.com/<owner>/<repo>/issues/<number> (or org/repo URL).",
      logger: params.logger,
    });
    return true;
  }

  const parsed = parseGithubContextFromText(rawArgs);
  if (!parsed) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: "Invalid GitHub URL. Example: /topic https://github.com/ubiquity-os/ubiquity-os-kernel/issues/1",
      logger: params.logger,
    });
    return true;
  }

  let override: TelegramRoutingOverride;
  try {
    override = buildTelegramRoutingOverride(parsed);
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to build Telegram topic context override");
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: "I couldn't apply that context. Please try a different GitHub URL.",
      logger: params.logger,
    });
    return true;
  }

  const activeTopicThreadId = params.messageThreadId ?? undefined;
  if (activeTopicThreadId && activeTopicThreadId !== TELEGRAM_GENERAL_TOPIC_ID) {
    const isSaved = await saveTelegramRoutingOverride({
      botToken: params.botToken,
      chatId: params.chat.id,
      threadId: activeTopicThreadId,
      override,
      logger: params.logger,
      kv,
    });
    if (!isSaved) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        messageThreadId: params.messageThreadId ?? undefined,
        replyToMessageId: params.replyToMessageId,
        text: TELEGRAM_CONTEXT_SAVE_ERROR,
        logger: params.logger,
      });
      return true;
    }

    const topicMessageId = await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: activeTopicThreadId,
      replyToMessageId: params.replyToMessageId,
      text: describeTelegramContext(override),
      logger: params.logger,
    });
    void safePinTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageId: topicMessageId,
      logger: params.logger,
    });
    return true;
  }

  const existingThreadId = await findTelegramTopicThreadIdForContext({
    kv,
    botId,
    chatId: params.chat.id,
    override,
    allowRepoFallback: true,
    logger: params.logger,
  });

  if (existingThreadId) {
    const isSaved = await saveTelegramRoutingOverride({
      botToken: params.botToken,
      chatId: params.chat.id,
      threadId: existingThreadId,
      override,
      logger: params.logger,
      kv,
    });
    if (!isSaved) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        messageThreadId: params.messageThreadId ?? undefined,
        replyToMessageId: params.replyToMessageId,
        text: TELEGRAM_CONTEXT_SAVE_ERROR,
        logger: params.logger,
      });
      return true;
    }

    const topicMessageId = await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: existingThreadId,
      text: describeTelegramContext(override),
      logger: params.logger,
    });
    void safePinTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageId: topicMessageId,
      logger: params.logger,
    });

    const topicLink = topicMessageId ? tryBuildTelegramMessageLink(params.chat, topicMessageId) : null;
    const topicLabel = describeTelegramContextLabel(override);
    const existingText = topicLink
      ? `Topic already exists: <a href="${escapeTelegramHtmlAttribute(topicLink)}">${escapeTelegramHtml(topicLabel)}</a>`
      : `Topic already exists: ${topicLabel}`;

    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: existingText,
      ...(topicLink ? { parseMode: "HTML" as const, disablePreview: true } : {}),
      logger: params.logger,
    });

    return true;
  }

  const topicName = clampTelegramTopicName(describeTelegramContextLabel(override));
  const created = await safeCreateTelegramForumTopic({
    botToken: params.botToken,
    chatId: params.chat.id,
    name: topicName,
    logger: params.logger,
  });
  if (!created.ok) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: created.error,
      logger: params.logger,
    });
    return true;
  }

  const isSaved = await saveTelegramRoutingOverride({
    botToken: params.botToken,
    chatId: params.chat.id,
    threadId: created.threadId,
    override,
    logger: params.logger,
    kv,
  });
  if (!isSaved) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: TELEGRAM_CONTEXT_SAVE_ERROR,
      logger: params.logger,
    });
    return true;
  }

  const topicMessageId = await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageThreadId: created.threadId,
    text: describeTelegramContext(override),
    logger: params.logger,
  });
  void safePinTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageId: topicMessageId,
    logger: params.logger,
  });

  const topicLink = topicMessageId ? tryBuildTelegramMessageLink(params.chat, topicMessageId) : null;
  const topicLabel = created.name.trim() || "topic";
  const createdText = topicLink
    ? `Topic created: <a href="${escapeTelegramHtmlAttribute(topicLink)}">${escapeTelegramHtml(topicLabel)}</a>`
    : `Topic created: ${topicLabel}`;

  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageThreadId: params.messageThreadId ?? undefined,
    replyToMessageId: params.replyToMessageId,
    text: createdText,
    ...(topicLink ? { parseMode: "HTML" as const } : {}),
    logger: params.logger,
  });
  return true;
}

type TelegramAutoTopicRoutingResult =
  | { mode: "none" }
  | { mode: "handled" }
  | {
      mode: "switched";
      override: TelegramRoutingOverride;
      threadId: number;
      anchorMessageId: number;
    };

export async function maybeAutoRouteTelegramWorkspaceMessageToTopic(params: {
  botToken: string;
  chat: TelegramChat;
  messageThreadId: number | null;
  replyToMessageId: number;
  rawText: string;
  userId: number;
  currentOverride: TelegramRoutingOverride | null;
  logger: Logger;
}): Promise<TelegramAutoTopicRoutingResult> {
  if (params.chat.type === "private" || params.chat.is_forum !== true) {
    return { mode: "none" };
  }

  const trimmed = params.rawText.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return { mode: "none" };
  }

  const parsed = parseGithubContextFromText(trimmed);
  if (!parsed) {
    return { mode: "none" };
  }

  let targetOverride: TelegramRoutingOverride;
  try {
    targetOverride = buildTelegramRoutingOverride(parsed);
  } catch {
    return { mode: "none" };
  }
  if (params.currentOverride && isSameTelegramRoutingOverride(params.currentOverride, targetOverride)) {
    return { mode: "none" };
  }

  const kv = await getTelegramKv(params.logger);
  if (!kv) {
    return { mode: "none" };
  }
  const botId = getTelegramBotId(params.botToken);
  const workspace = await loadTelegramWorkspaceByChat({
    kv,
    botId,
    chatId: params.chat.id,
    logger: params.logger,
  });
  if (!workspace) {
    return { mode: "none" };
  }

  const activePlan = await loadTelegramAgentPlanningSession({
    kv,
    key: buildTelegramAgentPlanningKey({
      botId,
      chatId: params.chat.id,
      threadId: params.messageThreadId,
      userId: params.userId,
    }),
    logger: params.logger,
  });
  if (activePlan) {
    return { mode: "none" };
  }

  let targetThreadId = await findTelegramTopicThreadIdForContext({
    kv,
    botId,
    chatId: params.chat.id,
    override: targetOverride,
    allowRepoFallback: true,
    logger: params.logger,
  });

  if (!targetThreadId) {
    const created = await safeCreateTelegramForumTopic({
      botToken: params.botToken,
      chatId: params.chat.id,
      name: describeTelegramContextLabel(targetOverride),
      logger: params.logger,
    });
    if (!created.ok) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        messageThreadId: params.messageThreadId ?? undefined,
        replyToMessageId: params.replyToMessageId,
        text: created.error,
        logger: params.logger,
      });
      return { mode: "handled" };
    }
    targetThreadId = created.threadId;
  }

  const isSaved = await saveTelegramRoutingOverride({
    botToken: params.botToken,
    chatId: params.chat.id,
    threadId: targetThreadId,
    override: targetOverride,
    logger: params.logger,
    kv,
  });
  if (!isSaved) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: TELEGRAM_CONTEXT_SAVE_ERROR,
      logger: params.logger,
    });
    return { mode: "handled" };
  }

  const sourceMessageLink = tryBuildTelegramMessageLink(params.chat, params.replyToMessageId);
  const targetLabel = describeTelegramContextLabel(targetOverride);
  const routedText = sourceMessageLink
    ? `Context auto-scoped to ${targetLabel}.\nSource: <a href="${escapeTelegramHtmlAttribute(sourceMessageLink)}">open original message</a>`
    : `Context auto-scoped to ${targetLabel}.`;
  const routedMessageId = await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageThreadId: targetThreadId,
    text: routedText,
    parseMode: "HTML",
    disablePreview: true,
    logger: params.logger,
  });
  if (!routedMessageId) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.messageThreadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: "I couldn't post in the new topic. Please try again.",
      logger: params.logger,
    });
    return { mode: "handled" };
  }
  void safePinTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageId: routedMessageId,
    logger: params.logger,
  });

  const topicLink = routedMessageId ? tryBuildTelegramMessageLink(params.chat, routedMessageId) : null;
  const sourceThreadId = params.messageThreadId && params.messageThreadId !== TELEGRAM_GENERAL_TOPIC_ID ? params.messageThreadId : undefined;
  const sourceText = topicLink ? `Opened topic for ${targetLabel} and scoped context there.` : `Opened/scoped topic for ${targetLabel}.`;
  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageThreadId: sourceThreadId,
    replyToMessageId: params.replyToMessageId,
    text: sourceText,
    ...(topicLink
      ? {
          replyMarkup: {
            inline_keyboard: [[{ text: "Open topic", url: topicLink }]],
          } as TelegramReplyMarkup,
        }
      : {}),
    logger: params.logger,
  });
  return {
    mode: "switched",
    override: targetOverride,
    threadId: targetThreadId,
    anchorMessageId: routedMessageId,
  };
}

export async function findTelegramTopicThreadIdForContext(params: {
  kv: KvLike;
  botId: string;
  chatId: number;
  override: TelegramRoutingOverride;
  allowRepoFallback?: boolean;
  logger: Logger;
}): Promise<number | null> {
  const prefix: KvKey = [...TELEGRAM_CONTEXT_PREFIX, params.botId, String(params.chatId), "topic"];

  const shouldUseRepoFallback =
    params.allowRepoFallback === true && params.override.kind === "repo" && parseOptionalPositiveInt(params.override.issueNumber) == null;
  let repoFallbackThreadId: number | null = null;

  try {
    for await (const entry of params.kv.list({ prefix }, { limit: 200 })) {
      const keyParts = entry.key as unknown[];
      const threadRaw = keyParts[prefix.length];
      const threadId = parseOptionalPositiveInt(threadRaw);
      if (!threadId) continue;

      const parsed = parseTelegramRoutingOverride(entry.value);
      if (!parsed) continue;

      if (isSameTelegramRoutingOverride(parsed, params.override)) {
        return threadId;
      }

      if (!shouldUseRepoFallback || repoFallbackThreadId) continue;
      if (parseOptionalPositiveInt(parsed.issueNumber) == null) continue;

      // Repo topics can temporarily become issue-scoped (session issues for agent runs).
      // When selecting a topic for a repo-level context, prefer strict matches but fall
      // back to an issue-scoped topic in the same repo to avoid creating duplicates.
      if (isSameTelegramRoutingOverride({ kind: "repo", owner: parsed.owner, repo: parsed.repo }, params.override)) {
        repoFallbackThreadId = threadId;
      }
    }
  } catch (error) {
    params.logger.warn({ err: error, chatId: params.chatId }, "Failed to scan Telegram topic contexts");
  }

  return repoFallbackThreadId;
}

export function getTelegramHelpCommands(commands: Array<{ name: string; description: string; example: string }>) {
  const merged: Array<{ name: string; description: string; example: string }> = [];
  const seen = new Set<string>();
  for (const command of [...TELEGRAM_SHIM_COMMANDS, ...commands]) {
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(command);
  }
  return merged;
}

export async function handleTelegramContextCommand(params: {
  botToken: string;
  chatId: number;
  threadId?: number;
  replyToMessageId: number;
  rawArgs: string;
  allowOverride: boolean;
  logger: Logger;
}): Promise<boolean> {
  if (!params.allowOverride) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "Context overrides are only available in shim mode.",
      logger: params.logger,
    });
    return true;
  }

  const kv = await getTelegramKv(params.logger);
  if (!kv) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "KV is unavailable, so I can't persist context yet.",
      logger: params.logger,
    });
    return true;
  }

  const rawArgs = params.rawArgs.trim();
  if (!rawArgs) {
    const current = await loadTelegramRoutingOverride({
      botToken: params.botToken,
      chatId: params.chatId,
      threadId: params.threadId,
      logger: params.logger,
      kv,
    });
    const message = current
      ? `Current context: ${describeTelegramContextLabel(current)}\nSet a new one with /topic <github-repo-or-issue-url>.`
      : "Usage: /topic https://github.com/<owner>/<repo>/issues/<number> (or org/repo URL).";
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: message,
      logger: params.logger,
    });
    return true;
  }

  const parsed = parseGithubContextFromText(rawArgs);
  if (!parsed) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "Invalid GitHub URL. Example: /topic https://github.com/ubiquity-os/.github-private/issues/8 or /topic https://github.com/0x4007-ubiquity-os",
      logger: params.logger,
    });
    return true;
  }

  let override: TelegramRoutingOverride;
  try {
    override = buildTelegramRoutingOverride(parsed);
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to build Telegram context override");
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "I couldn't apply that context. Please try a different GitHub URL.",
      logger: params.logger,
    });
    return true;
  }
  const isSaved = await saveTelegramRoutingOverride({
    botToken: params.botToken,
    chatId: params.chatId,
    threadId: params.threadId,
    override,
    logger: params.logger,
    kv,
  });

  if (!isSaved) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: TELEGRAM_CONTEXT_SAVE_ERROR,
      logger: params.logger,
    });
    return true;
  }

  const messageId = await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chatId,
    replyToMessageId: params.replyToMessageId,
    text: describeTelegramContext(override),
    logger: params.logger,
  });
  void safePinTelegramMessage({
    botToken: params.botToken,
    chatId: params.chatId,
    messageId,
    logger: params.logger,
  });
  return true;
}

export async function maybeSyncTelegramCommands(params: {
  botToken: string;
  commands: Array<{ name: string; description: string }>;
  logger: Logger;
}): Promise<void> {
  const normalized = normalizeTelegramCommands(params.commands);
  if (!normalized.length) return;
  const signature = JSON.stringify(normalized);
  const now = Date.now();
  const lastSignature = telegramCommandSyncState.lastSignature;
  const lastSyncAt = telegramCommandSyncState.lastSyncAt ?? 0;
  if (signature === lastSignature && now - lastSyncAt < TELEGRAM_COMMAND_SYNC_MIN_INTERVAL_MS) {
    return;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: normalized }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.warn({ status: response.status, detail }, "Failed to sync Telegram commands");
      return;
    }
    telegramCommandSyncState.lastSignature = signature;
    telegramCommandSyncState.lastSyncAt = now;
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to sync Telegram commands");
  }
}

function normalizeTelegramCommands(commands: Array<{ name: string; description: string }>): Array<{ command: string; description: string }> {
  const normalized: Array<{ command: string; description: string }> = [];
  for (const command of commands) {
    const name = normalizeTelegramCommandName(command.name);
    const description = normalizeTelegramDescription(command.description);
    if (!name || !description) continue;
    normalized.push({ command: name, description });
  }
  normalized.sort((a, b) => a.command.localeCompare(b.command));
  return normalized;
}

function normalizeTelegramCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

function normalizeTelegramDescription(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 256) return trimmed;
  return trimmed.slice(0, 253) + "...";
}

export function formatTelegramContextError(error: string, routing: TelegramRoutingConfig, environment: string): string {
  const normalized = error.trim();
  const target = formatRoutingLabel(routing);
  if (normalized.includes("No GitHub App installation found")) {
    return target
      ? `GitHub App is not installed for ${target}. Install it or use /topic with another repo.`
      : "GitHub App is not installed for that repo. Install it or use /topic with another repo.";
  }
  if (normalized.includes("No kernel configuration was found")) {
    const envLabel = environment?.trim() || "development";
    return target
      ? `No config found for ${target} (env: ${envLabel}). Add a .ubiquity-os config or import one.`
      : `No config found (env: ${envLabel}). Add a .ubiquity-os config or import one.`;
  }
  return normalized || "Telegram routing failed.";
}

export async function getTelegramKv(logger: Logger): Promise<KvLike | null> {
  const kv = await getKvClient(logger);
  if (!kv && !telegramKvState.hasTelegramKvWarningIssued) {
    logger.warn({ feature: "telegram-context" }, "KV unavailable; Telegram context will not persist.");
    telegramKvState.hasTelegramKvWarningIssued = true;
  }
  return kv;
}

export async function loadTelegramRoutingOverride(params: {
  botToken: string;
  chatId: number;
  threadId?: number;
  logger: Logger;
  kv?: KvLike | null;
}): Promise<TelegramRoutingOverride | null> {
  const kv = params.kv ?? (await getTelegramKv(params.logger));
  if (!kv) return null;
  if (params.threadId && params.threadId !== TELEGRAM_GENERAL_TOPIC_ID) {
    const topicKey = getTelegramTopicContextKey(params.botToken, params.chatId, params.threadId);
    const { value: topicValue } = await kv.get(topicKey);
    const parsedTopic = parseTelegramRoutingOverride(topicValue);
    if (parsedTopic) return parsedTopic;
  }
  const chatKey = getTelegramChatContextKey(params.botToken, params.chatId);
  const { value } = await kv.get(chatKey);
  return parseTelegramRoutingOverride(value);
}

export async function saveTelegramRoutingOverride(params: {
  botToken: string;
  chatId: number;
  threadId?: number;
  override: TelegramRoutingOverride;
  logger: Logger;
  kv?: KvLike | null;
}): Promise<boolean> {
  const kv = params.kv ?? (await getTelegramKv(params.logger));
  if (!kv) return false;
  const key =
    params.threadId && params.threadId !== TELEGRAM_GENERAL_TOPIC_ID
      ? getTelegramTopicContextKey(params.botToken, params.chatId, params.threadId)
      : getTelegramChatContextKey(params.botToken, params.chatId);
  const payload = {
    kind: params.override.kind,
    owner: params.override.owner,
    repo: params.override.repo,
    ...(params.override.issueNumber ? { issueNumber: params.override.issueNumber } : {}),
    ...(params.override.installationId ? { installationId: params.override.installationId } : {}),
    ...(params.override.sourceUrl ? { sourceUrl: params.override.sourceUrl } : {}),
    updatedAt: new Date().toISOString(),
  };
  try {
    await kv.set(key, payload);
    return true;
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to persist Telegram context");
    return false;
  }
}

export async function deleteTelegramRoutingOverridesForChat(params: { kv: KvLike; botId: string; chatId: number; logger: Logger }): Promise<void> {
  if (typeof params.kv.delete !== "function") return;
  const prefix: KvKey = [...TELEGRAM_CONTEXT_PREFIX, params.botId, String(params.chatId)];
  try {
    for await (const entry of params.kv.list({ prefix })) {
      await params.kv.delete(entry.key);
    }
  } catch (error) {
    params.logger.warn({ err: error, chatId: params.chatId }, "Failed to clear Telegram context overrides for chat");
  }
}

function getTelegramChatContextKey(botToken: string, chatId: number): KvKey {
  const botId = getTelegramBotId(botToken);
  return [...TELEGRAM_CONTEXT_PREFIX, botId, String(chatId)];
}

function getTelegramTopicContextKey(botToken: string, chatId: number, threadId: number): KvKey {
  const botId = getTelegramBotId(botToken);
  return [...TELEGRAM_CONTEXT_PREFIX, botId, String(chatId), "topic", String(threadId)];
}

export function getTelegramBotId(botToken: string): string {
  const trimmed = botToken.trim();
  const index = trimmed.indexOf(":");
  if (index > 0) {
    return trimmed.slice(0, index);
  }
  return trimmed || "unknown";
}
