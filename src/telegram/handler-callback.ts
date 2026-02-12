import { CONFIG_ORG_REPO } from "../github/utils/config.ts";
import { type Env } from "../github/types/env.ts";
import { parseAgentConfig, parseAiConfig, parseKernelConfig } from "../github/utils/env-config.ts";
import { parseGitHubAppConfig } from "../github/utils/github-app-config.ts";
import { parseTelegramChannelConfig } from "./channel-config.ts";
import {
  safeAnswerTelegramCallbackQuery,
  safeEditTelegramMessageReplyMarkup,
  safeSendTelegramMessage,
  startTelegramChatActionLoop,
  TELEGRAM_GENERAL_TOPIC_ID,
  type TelegramInlineKeyboardButton,
  type TelegramReplyMarkup,
} from "./api-client.ts";
import {
  buildTelegramAgentPlanningKey,
  deleteTelegramAgentPlanningSession,
  loadTelegramAgentPlanningSession,
  type TelegramAgentPlanningSession,
} from "./agent-planning.ts";
import {
  clearTelegramLinkPending,
  getOrCreateTelegramLinkCode,
  getTelegramLinkedIdentity,
  getTelegramLinkPending,
  saveTelegramLinkPending,
} from "./identity-store.ts";
import { initiateTelegramLinkIssue } from "./link.ts";
import { buildOrgUrl, type TelegramRoutingConfig } from "./routing-context.ts";
import { loadTelegramWorkspaceByChat } from "./workspace-store.ts";
import {
  type Logger,
  TELEGRAM_AGENT_PLANNING_CALLBACK_PREFIX,
  TELEGRAM_LINK_RETRY_CALLBACK_PREFIX,
  TELEGRAM_LINK_START_CALLBACK_DATA,
  TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR,
  TELEGRAM_START_LINKING_LABEL,
  type TelegramCallbackQuery,
  type TelegramMessage,
} from "./handler-shared.ts";
import { createGitHubContext, loadKernelConfigForOwner } from "./handler-context-loader.ts";
import { getTelegramAgentMemorySnippet } from "./handler-plugin-router.ts";
import { maybeHandleTelegramAgentPlanningSession } from "./handler-planning.ts";
import { formatTelegramContextError, getTelegramBotId, getTelegramKv, loadTelegramRoutingOverride } from "./handler-routing.ts";
import { resolveTelegramForumThreadId } from "./handler-webhook-utils.ts";
import { normalizeLogin, normalizePositiveInt } from "./normalization.ts";

type TelegramAgentPlanningKeyword = "approve" | "cancel" | "finalize";

export function buildTelegramLinkingKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: TELEGRAM_START_LINKING_LABEL,
          callback_data: TELEGRAM_LINK_START_CALLBACK_DATA,
        },
      ],
    ],
  };
}

export function buildTelegramIssueKeyboard(issueUrl: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [[{ text: "Open link issue", url: issueUrl }]],
  };
}

export function buildTelegramLinkRecoveryKeyboard(owner: string): TelegramReplyMarkup {
  const normalizedOwner = normalizeLogin(owner);
  const createRepoUrl = `https://github.com/new?owner=${encodeURIComponent(normalizedOwner)}&name=${encodeURIComponent(CONFIG_ORG_REPO)}`;

  const createRepo: TelegramInlineKeyboardButton = {
    text: `Create ${CONFIG_ORG_REPO}`,
    url: createRepoUrl,
  };
  const retry: TelegramInlineKeyboardButton = {
    text: "Retry",
    callback_data: `${TELEGRAM_LINK_RETRY_CALLBACK_PREFIX}${normalizedOwner}`,
  };
  const restart: TelegramInlineKeyboardButton = {
    text: "Start over",
    callback_data: TELEGRAM_LINK_START_CALLBACK_DATA,
  };

  return { inline_keyboard: [[createRepo, retry], [restart]] };
}

function parseTelegramLinkRetryCallbackData(data: string): string | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith(TELEGRAM_LINK_RETRY_CALLBACK_PREFIX)) return null;
  const rest = trimmed.slice(TELEGRAM_LINK_RETRY_CALLBACK_PREFIX.length);
  const normalizedOwner = normalizeLogin(rest);
  return normalizedOwner || null;
}

function buildTelegramAgentPlanningCallbackData(action: TelegramAgentPlanningKeyword, sessionId: string): string {
  const base = `${TELEGRAM_AGENT_PLANNING_CALLBACK_PREFIX}:${action}:${sessionId.trim()}`;
  return base.length <= 64 ? base : `${TELEGRAM_AGENT_PLANNING_CALLBACK_PREFIX}:${action}`;
}

export function buildTelegramAgentPlanningKeyboard(params: { status: TelegramAgentPlanningSession["status"]; sessionId: string }): TelegramReplyMarkup {
  const cancel: TelegramInlineKeyboardButton = {
    text: "Cancel",
    callback_data: buildTelegramAgentPlanningCallbackData("cancel", params.sessionId),
    style: "danger",
  };
  if (params.status !== "awaiting_approval") {
    const finalize: TelegramInlineKeyboardButton = {
      text: "Finalize plan",
      callback_data: buildTelegramAgentPlanningCallbackData("finalize", params.sessionId),
    };
    return { inline_keyboard: [[finalize, cancel]] };
  }

  const approve: TelegramInlineKeyboardButton = {
    text: "Approve",
    callback_data: buildTelegramAgentPlanningCallbackData("approve", params.sessionId),
  };
  return { inline_keyboard: [[approve, cancel]] };
}

function parseTelegramAgentPlanningCallbackData(data: string): {
  action: TelegramAgentPlanningKeyword;
  sessionId: string | null;
} | null {
  const trimmed = data.trim();
  const prefix = `${TELEGRAM_AGENT_PLANNING_CALLBACK_PREFIX}:`;
  if (!trimmed.startsWith(prefix)) return null;

  const rest = trimmed.slice(prefix.length);
  const firstColon = rest.indexOf(":");
  const actionPart = (firstColon >= 0 ? rest.slice(0, firstColon) : rest).trim().toLowerCase();
  const sessionId = (firstColon >= 0 ? rest.slice(firstColon + 1) : "").trim();

  if (actionPart !== "approve" && actionPart !== "cancel" && actionPart !== "finalize") {
    return null;
  }
  return {
    action: actionPart as TelegramAgentPlanningKeyword,
    sessionId: sessionId || null,
  };
}

export function formatTelegramLinkError(message: string, owner?: string): string[] {
  const trimmed = message.trim();
  if (!trimmed) return ["Linking failed. Try again."];
  const normalized = trimmed.toLowerCase();
  let hint = "";
  if (normalized.includes("issues has been disabled")) {
    hint = owner ? `Enable Issues in ${owner}/.ubiquity-os and try again.` : "Enable Issues in the .ubiquity-os repo.";
  } else if (normalized.includes("no github app installation")) {
    const repoHint = owner ? `${owner}/${CONFIG_ORG_REPO}` : CONFIG_ORG_REPO;
    hint = `Make sure ${repoHint} exists, has Issues enabled, and the UbiquityOS GitHub App is installed on it.`;
  } else if (normalized.includes("resource not accessible by integration")) {
    const repoHint = owner ? `${owner}/${CONFIG_ORG_REPO}` : CONFIG_ORG_REPO;
    hint = `Install the GitHub App on ${repoHint}.`;
  } else if (normalized.includes("invalid or expired link code")) {
    hint = "Send a new message to restart linking.";
  } else if (normalized.includes("link code already claimed")) {
    hint = "Send a new message to restart linking.";
  }
  return hint ? [trimmed, hint] : [trimmed];
}

export function parseGithubOwnerFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  let urlCandidate: string | null = null;
  if (withoutAt.startsWith("http://") || withoutAt.startsWith("https://")) {
    urlCandidate = withoutAt;
  } else if (withoutAt.includes("github.com/")) {
    urlCandidate = `https://${withoutAt}`;
  }
  if (urlCandidate) {
    try {
      const url = new URL(urlCandidate);
      if (url.hostname.toLowerCase().endsWith("github.com")) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length > 0) {
          return normalizeLogin(parts[0]);
        }
      }
    } catch {
      return null;
    }
  }

  if (/\s/.test(withoutAt)) {
    return null;
  }

  const ownerPart = withoutAt.split("/")[0] ?? "";
  const normalized = normalizeLogin(ownerPart);
  return normalized || null;
}

export async function handleTelegramCallbackQuery(params: {
  callbackQuery: TelegramCallbackQuery;
  botToken: string;
  env: Env;
  updateId: number;
  requestUrl: string;
  logger: Logger;
}): Promise<void> {
  const { callbackQuery, botToken, logger } = params;
  const data = (callbackQuery.data ?? "").trim();
  if (!data) {
    await safeAnswerTelegramCallbackQuery({
      botToken,
      callbackQueryId: callbackQuery.id,
      logger,
    });
    return;
  }

  const typingChatId = callbackQuery.message?.chat?.id;
  const typingMessageThreadId = normalizePositiveInt(callbackQuery.message?.message_thread_id);
  const stopTyping =
    typeof typingChatId === "number"
      ? startTelegramChatActionLoop({
          botToken,
          chatId: typingChatId,
          messageThreadId: typingMessageThreadId ?? undefined,
          action: "typing",
          logger,
        })
      : () => {};
  try {
    if (data === TELEGRAM_LINK_START_CALLBACK_DATA) {
      const userId = callbackQuery.from?.id;
      const chatId = callbackQuery.message?.chat?.id;
      if (typeof userId !== "number" || typeof chatId !== "number") {
        await safeAnswerTelegramCallbackQuery({
          botToken,
          callbackQueryId: callbackQuery.id,
          logger,
        });
        return;
      }

      const identityResult = await getTelegramLinkedIdentity({
        userId,
        logger,
      });
      if (!identityResult.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: identityResult.error,
          logger,
        });
        await safeAnswerTelegramCallbackQuery({
          botToken,
          callbackQueryId: callbackQuery.id,
          logger,
        });
        return;
      }
      if (identityResult.identity?.owner) {
        const existingGithubLogin = normalizeLogin(identityResult.identity.githubLogin ?? "");
        if (!existingGithubLogin) {
          await safeSendTelegramMessage({
            botToken,
            chatId,
            replyToMessageId: callbackQuery.message?.message_id,
            text: "Your link is missing GitHub login metadata. Starting re-link flow now.",
            logger,
          });
        } else {
          await safeSendTelegramMessage({
            botToken,
            chatId,
            replyToMessageId: callbackQuery.message?.message_id,
            text: `Already linked to ${identityResult.identity.owner}.`,
            logger,
          });
          await safeAnswerTelegramCallbackQuery({
            botToken,
            callbackQueryId: callbackQuery.id,
            logger,
          });
          return;
        }
      }

      const linkCodeResult = await getOrCreateTelegramLinkCode({
        userId,
        logger,
      });
      if (!linkCodeResult.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: linkCodeResult.error,
          logger,
        });
        await safeAnswerTelegramCallbackQuery({
          botToken,
          callbackQueryId: callbackQuery.id,
          logger,
        });
        return;
      }

      const pendingSave = await saveTelegramLinkPending({
        userId,
        code: linkCodeResult.code,
        step: "awaiting_owner",
        expiresAtMs: linkCodeResult.expiresAtMs,
        logger,
      });
      if (!pendingSave.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: pendingSave.error,
          logger,
        });
        await safeAnswerTelegramCallbackQuery({
          botToken,
          callbackQueryId: callbackQuery.id,
          logger,
        });
        return;
      }

      await safeSendTelegramMessage({
        botToken,
        chatId,
        replyToMessageId: callbackQuery.message?.message_id,
        text: [
          "Send the GitHub owner (username or org) you want to link. Example: ubiquity-os",
          "",
          `Note: that owner must have a ${CONFIG_ORG_REPO} repo with Issues enabled, and the UbiquityOS GitHub App installed on it.`,
        ].join("\n"),
        logger,
      });

      await safeAnswerTelegramCallbackQuery({
        botToken,
        callbackQueryId: callbackQuery.id,
        text: "Send the GitHub owner name.",
        logger,
      });
      return;
    }

    const retryOwner = parseTelegramLinkRetryCallbackData(data);
    if (retryOwner) {
      const userId = callbackQuery.from?.id;
      const chatId = callbackQuery.message?.chat?.id;
      if (typeof userId !== "number" || typeof chatId !== "number") {
        await safeAnswerTelegramCallbackQuery({
          botToken,
          callbackQueryId: callbackQuery.id,
          logger,
        });
        return;
      }

      await safeAnswerTelegramCallbackQuery({
        botToken,
        callbackQueryId: callbackQuery.id,
        text: "Retrying...",
        logger,
      });

      const identityResult = await getTelegramLinkedIdentity({
        userId,
        logger,
      });
      if (!identityResult.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: identityResult.error,
          logger,
        });
        return;
      }
      if (identityResult.identity?.owner) {
        const existingGithubLogin = normalizeLogin(identityResult.identity.githubLogin ?? "");
        if (existingGithubLogin) {
          await safeSendTelegramMessage({
            botToken,
            chatId,
            replyToMessageId: callbackQuery.message?.message_id,
            text: `Already linked to ${identityResult.identity.owner}.`,
            logger,
          });
          return;
        }
      }

      const pendingResult = await getTelegramLinkPending({ userId, logger });
      if (!pendingResult.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: pendingResult.error,
          logger,
        });
        return;
      }

      let pending = pendingResult.pending;
      if (pending && pending.expiresAtMs <= Date.now()) {
        await clearTelegramLinkPending({ userId, logger });
        pending = null;
      }

      if (!pending || pending.step !== "awaiting_owner") {
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: `No active link request found. Tap ${TELEGRAM_START_LINKING_LABEL} to try again.`,
          replyMarkup: buildTelegramLinkingKeyboard(),
          logger,
        });
        return;
      }

      const issueResult = await initiateTelegramLinkIssue({
        env: params.env,
        code: pending.code,
        owner: retryOwner,
        logger,
        requestUrl: params.requestUrl,
      });
      if (!issueResult.ok) {
        const lines = formatTelegramLinkError(issueResult.error, retryOwner);
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: lines.join("\n"),
          replyMarkup: buildTelegramLinkRecoveryKeyboard(retryOwner),
          logger,
        });
        return;
      }

      const pendingSave = await saveTelegramLinkPending({
        userId,
        code: pending.code,
        step: "awaiting_close",
        expiresAtMs: pending.expiresAtMs,
        owner: retryOwner,
        logger,
      });
      if (!pendingSave.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: pendingSave.error,
          logger,
        });
        return;
      }

      const createdLines = [
        `Link issue created for ${retryOwner}/.ubiquity-os.`,
        `Issue: ${issueResult.issueUrl}`,
        "",
        "Close the issue to approve.",
        "I'll DM you once it's linked.",
      ];
      await safeSendTelegramMessage({
        botToken,
        chatId,
        replyToMessageId: callbackQuery.message?.message_id,
        text: createdLines.join("\n"),
        replyMarkup: buildTelegramIssueKeyboard(issueResult.issueUrl),
        logger,
      });
      return;
    }

    const planningCallback = parseTelegramAgentPlanningCallbackData(data);
    if (planningCallback) {
      await handleTelegramAgentPlanningCallbackQuery({
        callbackQuery,
        botToken,
        env: params.env,
        updateId: params.updateId,
        requestUrl: params.requestUrl,
        action: planningCallback.action,
        expectedSessionId: planningCallback.sessionId,
        logger,
      });
      return;
    }

    await safeAnswerTelegramCallbackQuery({
      botToken,
      callbackQueryId: callbackQuery.id,
      logger,
    });
  } finally {
    stopTyping();
  }
}

async function handleTelegramAgentPlanningCallbackQuery(params: {
  callbackQuery: TelegramCallbackQuery;
  botToken: string;
  env: Env;
  updateId: number;
  requestUrl: string;
  action: TelegramAgentPlanningKeyword;
  expectedSessionId: string | null;
  logger: Logger;
}): Promise<void> {
  const { callbackQuery, botToken, logger } = params;
  const userId = callbackQuery.from?.id;
  const message = callbackQuery.message;
  const chatId = message?.chat?.id;
  if (typeof userId !== "number" || typeof chatId !== "number" || !message) {
    await safeAnswerTelegramCallbackQuery({
      botToken,
      callbackQueryId: callbackQuery.id,
      logger,
    });
    return;
  }

  let callbackText = "Cancelling...";
  if (params.action === "approve") {
    callbackText = "Starting...";
  } else if (params.action === "finalize") {
    callbackText = "Finalizing...";
  }
  await safeAnswerTelegramCallbackQuery({
    botToken,
    callbackQueryId: callbackQuery.id,
    text: callbackText,
    logger,
  });

  // Clear action buttons once pressed (avoid double-press and stale UI).
  await safeEditTelegramMessageReplyMarkup({
    botToken,
    chatId,
    messageId: message.message_id,
    replyMarkup: { inline_keyboard: [[]] },
    logger,
  });

  const kv = await getTelegramKv(logger);
  if (!kv) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: "KV is unavailable, so planning mode is disabled right now.",
      logger,
    });
    return;
  }

  const messageThreadId = normalizePositiveInt(message.message_thread_id);
  const isForum = message.chat.is_forum === true;
  const resolvedThreadId = resolveTelegramForumThreadId({
    isForum,
    messageThreadId,
  });
  const contextThreadId = resolvedThreadId && resolvedThreadId !== TELEGRAM_GENERAL_TOPIC_ID ? resolvedThreadId : null;

  const botId = getTelegramBotId(botToken);
  const key = buildTelegramAgentPlanningKey({
    botId,
    chatId,
    threadId: contextThreadId,
    userId,
  });
  const session = await loadTelegramAgentPlanningSession({
    kv,
    key,
    logger,
  });
  if (!session) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR,
      logger,
    });
    return;
  }
  if (params.expectedSessionId && params.expectedSessionId !== session.id) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: "That plan is stale. Use the latest plan message.",
      logger,
    });
    return;
  }

  if (params.action === "cancel") {
    await deleteTelegramAgentPlanningSession({ kv, key, logger });
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: "Cancelled.",
      logger,
    });
    return;
  }

  const identityResult = await getTelegramLinkedIdentity({ userId, logger });
  if (!identityResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: identityResult.error,
      logger,
    });
    return;
  }

  let effectiveIdentity = identityResult.identity;
  let workspace: Awaited<ReturnType<typeof loadTelegramWorkspaceByChat>> | null = null;
  if (message.chat.type !== "private" && isForum) {
    workspace = await loadTelegramWorkspaceByChat({
      kv,
      botId,
      chatId,
      logger,
    });
    if (workspace) {
      const workspaceOwnerResult = await getTelegramLinkedIdentity({
        userId: workspace.userId,
        logger,
      });
      if (workspaceOwnerResult.ok && workspaceOwnerResult.identity) {
        effectiveIdentity = workspaceOwnerResult.identity;
      }
    }
  }

  if (!effectiveIdentity) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text:
        message.chat.type === "private"
          ? "Please link your GitHub owner first. Use /_status."
          : "No linked GitHub owner for this chat. Use /_status in DM to link.",
      logger,
    });
    return;
  }

  const effectiveOwner = effectiveIdentity.owner;
  const githubConfigResult = parseGitHubAppConfig(params.env);
  if (!githubConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: githubConfigResult.error,
      logger,
    });
    return;
  }
  const aiConfigResult = parseAiConfig(params.env.UOS_AI);
  if (!aiConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: aiConfigResult.error,
      logger,
    });
    return;
  }
  const agentConfigResult = parseAgentConfig(params.env.UOS_AGENT);
  if (!agentConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: agentConfigResult.error,
      logger,
    });
    return;
  }
  const kernelConfigResult = parseKernelConfig(params.env.UOS_KERNEL);
  if (!kernelConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: kernelConfigResult.error,
      logger,
    });
    return;
  }

  const kernelRefreshUrl = new URL("/internal/agent/refresh-token", params.requestUrl).toString();
  const kernelConfigLoad = await loadKernelConfigForOwner({
    owner: effectiveOwner,
    env: params.env,
    logger,
    githubConfig: githubConfigResult.config,
    aiConfig: aiConfigResult.config,
    agentConfig: agentConfigResult.config,
    kernelConfig: kernelConfigResult.config,
    kernelRefreshUrl,
  });
  if (!kernelConfigLoad.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: kernelConfigLoad.error,
      logger,
    });
    return;
  }

  const channelConfigResult = parseTelegramChannelConfig(kernelConfigLoad.config, { fallbackOwner: effectiveOwner });
  if (!channelConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: channelConfigResult.error,
      logger,
    });
    return;
  }
  const channelConfig = channelConfigResult.config;

  let routingOverride =
    channelConfig.mode === "shim"
      ? await loadTelegramRoutingOverride({
          botToken,
          chatId,
          threadId: contextThreadId ?? undefined,
          logger,
          kv,
        })
      : null;
  if (channelConfig.mode === "shim" && !routingOverride) {
    if (message.chat.type === "private" || workspace) {
      routingOverride = {
        kind: "org",
        owner: channelConfig.owner,
        repo: CONFIG_ORG_REPO,
        sourceUrl: buildOrgUrl(channelConfig.owner),
      };
    } else {
      await safeSendTelegramMessage({
        botToken,
        chatId,
        replyToMessageId: message.message_id,
        text: "Set context with /topic <github-repo-or-issue-url> before starting agent runs.",
        logger,
      });
      return;
    }
  }

  const routing: TelegramRoutingConfig =
    channelConfig.mode === "shim"
      ? {
          owner: routingOverride?.owner,
          repo: routingOverride?.repo,
          issueNumber: routingOverride?.issueNumber,
          installationId: routingOverride?.installationId,
        }
      : {
          owner: channelConfig.owner,
          repo: channelConfig.repo,
          issueNumber: channelConfig.issueNumber,
          installationId: channelConfig.installationId,
        };

  const syntheticMessage: TelegramMessage = {
    message_id: message.message_id,
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    text: session.request,
    from: callbackQuery.from,
    chat: message.chat,
  };

  const contextResult = await createGitHubContext({
    env: params.env,
    logger,
    updateId: params.updateId,
    message: syntheticMessage,
    rawText: session.request,
    kernelRefreshUrl,
    routing,
    actorIdentity: effectiveIdentity,
    githubConfig: githubConfigResult.config,
    aiConfig: aiConfigResult.config,
    agentConfig: agentConfigResult.config,
    kernelConfig: kernelConfigResult.config,
    kernelConfigOverride: undefined,
    eventHandlerOverride: kernelConfigLoad.eventHandler,
  });
  if (!contextResult.ok) {
    const messageText = formatTelegramContextError(contextResult.error, routing, params.env.ENVIRONMENT);
    await safeSendTelegramMessage({
      botToken,
      chatId,
      replyToMessageId: message.message_id,
      text: messageText,
      logger,
    });
    return;
  }

  const planningAgentMemory = await getTelegramAgentMemorySnippet({
    context: contextResult.context,
    query: session.request,
    hasIssueContext: contextResult.hasIssueContext,
    logger,
  });

  await maybeHandleTelegramAgentPlanningSession({
    context: contextResult.context,
    botToken,
    chat: message.chat,
    threadId: contextThreadId,
    userId,
    replyToMessageId: message.message_id,
    rawText: "",
    conversationContext: "",
    agentMemory: planningAgentMemory,
    routing,
    routingOverride,
    channelMode: channelConfig.mode,
    actorIdentity: effectiveIdentity,
    updateId: params.updateId,
    message: syntheticMessage,
    logger,
    hasIssueContext: contextResult.hasIssueContext,
    intent: params.action === "finalize" ? "finalize" : "approve",
  });
}
