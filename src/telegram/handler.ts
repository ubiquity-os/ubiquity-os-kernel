import { Context } from "hono";
import { type Env } from "../github/types/env.ts";
import { type KvKey } from "../github/utils/kv-client.ts";
import { classifyTextIngress } from "../github/utils/reaction.ts";
import { parseLeadingSlashCommand } from "../github/utils/slash-command.ts";
import { logger as baseLogger } from "../logger/logger.ts";
import { safeSendTelegramMessage, startTelegramChatActionLoop, TELEGRAM_GENERAL_TOPIC_ID } from "./api-client.ts";
import {
  clearTelegramLinkPending,
  getTelegramLinkedIdentity,
  getTelegramLinkIssue,
  getTelegramLinkPending,
  saveTelegramLinkPending,
} from "./identity-store.ts";
import { initiateTelegramLinkIssue } from "./link.ts";
import { buildTelegramAgentPlanningKey, loadTelegramAgentPlanningSession, parseTelegramAgentPlanningSession } from "./agent-planning.ts";
import { normalizePositiveInt } from "./normalization.ts";
import {
  buildTelegramIssueKeyboard,
  buildTelegramLinkingKeyboard,
  buildTelegramLinkRecoveryKeyboard,
  formatTelegramLinkError,
  handleTelegramCallbackQuery,
  parseGithubOwnerFromText,
} from "./handler-callback.ts";
import {
  handleTelegramChatMemberUpdate,
  maybeFinalizeTelegramWorkspaceBootstrap,
  maybeHandleTelegramWorkspaceOwnerLeft,
} from "./handler-workspace-bootstrap.ts";
import { handleTelegramMyChatMemberUpdate } from "./handler-chat-admin.ts";
import { getTelegramBotId, getTelegramKv } from "./handler-routing.ts";
import { handleTelegramStatusCommand } from "./handler-issue-context.ts";
import {
  getClassificationText,
  getTelegramCallbackQuery,
  getTelegramChatMemberUpdate,
  getTelegramMessage,
  getTelegramMyChatMemberUpdate,
  getTelegramText,
  parseTelegramSecretsConfig,
  resolveTelegramForumThreadId,
} from "./handler-webhook-utils.ts";
import { runTelegramWebhookIdentityFlow } from "./handler-webhook-identity-flow.ts";
import { normalizeTelegramUserCommandName, TELEGRAM_START_LINKING_LABEL, type TelegramUpdate } from "./handler-shared.ts";
import { loadTelegramWorkspaceByChat } from "./workspace-store.ts";

export async function handleTelegramWebhook(ctx: Context, env: Env): Promise<Response> {
  const logger = ctx.var.logger ?? baseLogger;
  const secretsResult = parseTelegramSecretsConfig(env);
  if (!secretsResult.ok) {
    return ctx.json({ error: secretsResult.error }, secretsResult.status);
  }
  const secrets = secretsResult.config;
  const botToken = secrets.botToken;

  if (secrets.webhookSecret) {
    const provided = ctx.req.header("x-telegram-bot-api-secret-token") ?? "";
    if (provided !== secrets.webhookSecret) {
      logger.warn({ hasHeader: Boolean(provided) }, "Telegram webhook rejected (secret token mismatch).");
      return ctx.json({ error: "Unauthorized." }, 401);
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await ctx.req.json()) as TelegramUpdate;
  } catch (error) {
    logger.warn({ err: error }, "Failed to parse Telegram update payload");
    return ctx.json({ error: "Invalid JSON payload." }, 400);
  }

  const callbackQuery = getTelegramCallbackQuery(update);
  if (callbackQuery) {
    await handleTelegramCallbackQuery({
      callbackQuery,
      botToken,
      env,
      updateId: update.update_id,
      requestUrl: ctx.req.url,
      logger,
    });
    return ctx.text("", 200);
  }

  const myChatMemberUpdate = getTelegramMyChatMemberUpdate(update);
  if (myChatMemberUpdate) {
    await handleTelegramMyChatMemberUpdate({
      botToken,
      update: myChatMemberUpdate,
      logger,
    });
    return ctx.text("", 200);
  }

  const chatMemberUpdate = getTelegramChatMemberUpdate(update);
  if (chatMemberUpdate) {
    await handleTelegramChatMemberUpdate({
      botToken,
      update: chatMemberUpdate,
      logger,
    });
    return ctx.text("", 200);
  }

  const message = getTelegramMessage(update);
  if (!message) {
    return ctx.text("", 200);
  }

  const telegramUserId = typeof message.from?.id === "number" ? message.from.id : null;

  if (message.chat.type !== "private") {
    const leftMemberId = typeof message.left_chat_member?.id === "number" ? message.left_chat_member.id : null;
    if (leftMemberId) {
      logger.info(
        {
          chatId: message.chat.id,
          userId: leftMemberId,
          event: "telegram-left-member",
        },
        "Telegram left_chat_member event"
      );
      await maybeHandleTelegramWorkspaceOwnerLeft({
        botToken,
        chatId: message.chat.id,
        userId: leftMemberId,
        logger,
      });
    }

    const newMembers = Array.isArray(message.new_chat_members) ? message.new_chat_members : [];
    const memberIds = newMembers.map((member) => (typeof member?.id === "number" ? member.id : null)).filter((id): id is number => typeof id === "number");

    if (memberIds.length) {
      logger.info(
        {
          chatId: message.chat.id,
          memberIds,
          event: "telegram-new-members",
          updateId: update.update_id,
        },
        "Telegram new_chat_members event"
      );
      for (const memberId of memberIds) {
        await maybeFinalizeTelegramWorkspaceBootstrap({
          botToken,
          chatId: message.chat.id,
          userId: memberId,
          logger,
          source: "message.new_chat_members",
        });
      }
    } else if (telegramUserId) {
      // Only treat actual user messages as a "retry" signal. Telegram service messages like
      // `left_chat_member` can include a `from` user, but promoting in response to them is noisy
      // and can fail if the user is not currently a member of the group.
      const hasUserText = (typeof message.text === "string" && message.text.trim()) || (typeof message.caption === "string" && message.caption.trim());
      if (!hasUserText) {
        return ctx.text("", 200);
      }
      // Finalize DM-bootstrapped workspaces before classification so the first message can be handled.
      await maybeFinalizeTelegramWorkspaceBootstrap({
        botToken,
        chatId: message.chat.id,
        userId: telegramUserId,
        logger,
        source: "message.sender",
      });
    }
  }

  const rawText = getTelegramText(message);
  if (!rawText.trim()) {
    return ctx.text("", 200);
  }

  const messageThreadId = normalizePositiveInt(message.message_thread_id);
  const isForum = message.chat.is_forum === true;
  const resolvedThreadId = resolveTelegramForumThreadId({
    isForum,
    messageThreadId,
  });
  const contextThreadId = resolvedThreadId && resolvedThreadId !== TELEGRAM_GENERAL_TOPIC_ID ? resolvedThreadId : null;
  const effectiveMessageThreadId = messageThreadId;
  const effectiveContextThreadId = contextThreadId;
  let cachedWorkspaceByChat: Awaited<ReturnType<typeof loadTelegramWorkspaceByChat>> | null | undefined;

  const loadWorkspaceByChatOnce = async (): Promise<Awaited<ReturnType<typeof loadTelegramWorkspaceByChat>> | null> => {
    if (cachedWorkspaceByChat !== undefined) return cachedWorkspaceByChat;
    if (message.chat.type === "private" || !isForum) {
      cachedWorkspaceByChat = null;
      return null;
    }
    const kv = await getTelegramKv(logger);
    if (!kv) {
      cachedWorkspaceByChat = null;
      return null;
    }
    const botId = getTelegramBotId(botToken);
    cachedWorkspaceByChat = await loadTelegramWorkspaceByChat({
      kv,
      botId,
      chatId: message.chat.id,
      logger,
    });
    return cachedWorkspaceByChat;
  };

  let classificationText = getClassificationText(rawText, message.chat);
  let stimulus = classifyTextIngress(classificationText);
  if (
    stimulus.reaction === "ignore" &&
    message.chat.type !== "private" &&
    isForum &&
    !classificationText.trim().startsWith("/") &&
    !classificationText.trim().startsWith("@")
  ) {
    const workspace = await loadWorkspaceByChatOnce();
    if (workspace) {
      // Treat messages inside claimed workspaces as implicit @ubiquityos (including General topic).
      const trimmed = rawText.trim();
      classificationText = trimmed ? `@ubiquityos ${trimmed}` : trimmed;
      stimulus = classifyTextIngress(classificationText);
    }
  }

  if (stimulus.reaction === "ignore" && telegramUserId !== null) {
    const kv = await getTelegramKv(logger);
    if (kv) {
      const botId = getTelegramBotId(botToken);
      const key = buildTelegramAgentPlanningKey({
        botId,
        chatId: message.chat.id,
        threadId: contextThreadId,
        userId: telegramUserId,
      });
      const session = await loadTelegramAgentPlanningSession({
        kv,
        key,
        logger,
      });
      if (session) {
        const trimmed = rawText.trim();
        classificationText = trimmed ? `@ubiquityos ${trimmed}` : trimmed;
        stimulus = classifyTextIngress(classificationText);
      } else {
        const prefix: KvKey = ["ubiquityos", "telegram", "agent-planning", botId, String(message.chat.id)];
        const normalizedUserId = String(telegramUserId);
        const nowMs = Date.now();
        let hasOtherSession = false;
        let hasMatchingSession = false;
        try {
          for await (const entry of kv.list({ prefix }, { limit: 50 })) {
            const keyParts = entry.key as unknown[];
            if (!keyParts.length) continue;
            if (String(keyParts[keyParts.length - 1]) !== normalizedUserId) {
              continue;
            }
            const candidate = parseTelegramAgentPlanningSession(entry.value);
            if (!candidate) continue;
            if (candidate.expiresAtMs <= nowMs) continue;

            hasOtherSession = true;
            const marker = keyParts.length > 5 ? keyParts[5] : null;
            let threadIdFromKey: number | null = null;
            if (marker === "topic" && keyParts.length > 6) {
              const parsed = Number(String(keyParts[6]));
              if (Number.isFinite(parsed) && parsed > 0) {
                threadIdFromKey = Math.trunc(parsed);
              }
            }
            if (threadIdFromKey === contextThreadId) {
              hasMatchingSession = true;
              break;
            }
          }
        } catch (error) {
          logger.warn(
            {
              err: error,
              chatId: message.chat.id,
              userId: telegramUserId,
            },
            "Failed to scan Telegram agent planning sessions (non-fatal)"
          );
        }

        if (hasMatchingSession) {
          const trimmed = rawText.trim();
          classificationText = trimmed ? `@ubiquityos ${trimmed}` : trimmed;
          stimulus = classifyTextIngress(classificationText);
        } else if (hasOtherSession) {
          const hintKey: KvKey = ["ubiquityos", "telegram", "agent-planning", "hint", botId, String(message.chat.id), normalizedUserId];
          let shouldHint = true;
          try {
            const hintState = await kv.get(hintKey);
            if (hintState.value) shouldHint = false;
          } catch {
            // ignore
          }
          if (shouldHint) {
            try {
              await kv.set(hintKey, { at: nowMs }, { expireIn: 2 * 60_000 });
            } catch {
              // ignore
            }
            const stopTyping = startTelegramChatActionLoop({
              botToken,
              chatId: message.chat.id,
              messageThreadId: effectiveMessageThreadId ?? undefined,
              action: "typing",
              logger,
            });
            try {
              await safeSendTelegramMessage({
                botToken,
                chatId: message.chat.id,
                replyToMessageId: message.message_id,
                text: "You have an active plan in another topic/chat. Please answer in the same topic where the plan was posted (or reply to the plan message) so I can attach your answers.",
                logger,
              });
            } finally {
              stopTyping();
            }
          }
          return ctx.text("", 200);
        }
      }
    }
  }
  logger.debug(
    { event: "telegram-stimulus", command: stimulus.slashInvocation?.name },
    `Telegram stimulus: reaction=${stimulus.reaction} reflex=${stimulus.reflex ?? "none"}`
  );
  if (stimulus.reaction === "ignore") {
    return ctx.text("", 200);
  }

  const stopTyping = startTelegramChatActionLoop({
    botToken,
    chatId: message.chat.id,
    messageThreadId: effectiveMessageThreadId ?? undefined,
    action: "typing",
    logger,
  });
  try {
    const invocation = stimulus.reflex === "slash" ? stimulus.slashInvocation : null;
    const commandName = invocation ? normalizeTelegramUserCommandName(invocation.name) : undefined;
    const rawSlashInvocation = parseLeadingSlashCommand(rawText);
    const rawCommandName = rawSlashInvocation ? normalizeTelegramUserCommandName(rawSlashInvocation.name) : undefined;
    if (telegramUserId === null) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: "I couldn't identify your Telegram account. Please try again from a user message.",
        logger,
      });
      return ctx.text("", 200);
    }

    const identityResult = await getTelegramLinkedIdentity({
      userId: telegramUserId,
      logger,
    });
    if (!identityResult.ok) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: identityResult.error,
        logger,
      });
      return ctx.text("", 200);
    }
    if (commandName === "status" || rawCommandName === "status") {
      const isHandled = await handleTelegramStatusCommand({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        userId: telegramUserId,
        identity: identityResult.identity,
        isPrivate: message.chat.type === "private",
        logger,
      });
      if (isHandled) {
        return ctx.text("", 200);
      }
    }

    // In claimed workspace chats, always route through the workspace owner's linked
    // identity/config so participants share the same command set and don't need to link
    // individually.
    let effectiveIdentity = identityResult.identity;
    if (message.chat.type !== "private") {
      const workspace = await loadWorkspaceByChatOnce();
      if (workspace) {
        const workspaceOwnerResult = await getTelegramLinkedIdentity({
          userId: workspace.userId,
          logger,
        });
        if (workspaceOwnerResult.ok && workspaceOwnerResult.identity) {
          effectiveIdentity = workspaceOwnerResult.identity;
          logger.debug(
            {
              chatId: message.chat.id,
              actorUserId: telegramUserId,
              workspaceOwnerUserId: workspace.userId,
              owner: effectiveIdentity.owner,
            },
            "Using workspace owner identity for Telegram routing"
          );
        }
      }
    }

    if (message.chat.type === "private" && effectiveIdentity) {
      const pendingResult = await getTelegramLinkPending({
        userId: telegramUserId,
        logger,
      });
      if (!pendingResult.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: pendingResult.error,
          logger,
        });
        return ctx.text("", 200);
      }

      let pending = pendingResult.pending;
      if (pending && pending.expiresAtMs <= Date.now()) {
        await clearTelegramLinkPending({ userId: telegramUserId, logger });
        pending = null;
      }

      if (pending?.step === "awaiting_owner") {
        const ownerInput = parseGithubOwnerFromText(rawText);
        if (!ownerInput) {
          await safeSendTelegramMessage({
            botToken,
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            text: "Send just your GitHub owner (username or org), or paste a GitHub URL.",
            logger,
          });
          return ctx.text("", 200);
        }

        const issueResult = await initiateTelegramLinkIssue({
          env,
          code: pending.code,
          owner: ownerInput,
          logger,
          requestUrl: ctx.req.url,
        });
        if (!issueResult.ok) {
          const normalizedError = issueResult.error.toLowerCase();
          const shouldShowRecoveryKeyboard = normalizedError.includes("no github app installation found");
          if (normalizedError.includes("expired") || normalizedError.includes("link code already claimed")) {
            await clearTelegramLinkPending({ userId: telegramUserId, logger });
          }
          const lines = formatTelegramLinkError(issueResult.error, ownerInput);
          await safeSendTelegramMessage({
            botToken,
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            text: lines.join("\n"),
            ...(shouldShowRecoveryKeyboard ? { replyMarkup: buildTelegramLinkRecoveryKeyboard(ownerInput) } : {}),
            logger,
          });
          return ctx.text("", 200);
        }

        const pendingSave = await saveTelegramLinkPending({
          userId: telegramUserId,
          code: pending.code,
          step: "awaiting_close",
          expiresAtMs: pending.expiresAtMs,
          owner: ownerInput,
          logger,
        });
        if (!pendingSave.ok) {
          await safeSendTelegramMessage({
            botToken,
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            text: pendingSave.error,
            logger,
          });
          return ctx.text("", 200);
        }

        const createdLines = [
          `Link issue created for ${ownerInput}/.ubiquity-os.`,
          `Issue: ${issueResult.issueUrl}`,
          "",
          "Close the issue to approve.",
          "I'll DM you once it's linked.",
        ];
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: createdLines.join("\n"),
          replyMarkup: buildTelegramIssueKeyboard(issueResult.issueUrl),
          logger,
        });
        return ctx.text("", 200);
      }

      if (pending?.step === "awaiting_close" || pending?.step === "awaiting_reaction") {
        let issueUrl = "";
        const issueResult = await getTelegramLinkIssue({
          code: pending.code,
          logger,
        });
        if (issueResult.ok && issueResult.issue?.issueUrl) {
          issueUrl = issueResult.issue.issueUrl;
        }
        const waitingLines = [
          "Waiting for you to close the link issue.",
          issueUrl ? `Issue: ${issueUrl}` : "",
          "Close the issue and I'll DM you once linked.",
        ].filter(Boolean);
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: waitingLines.join("\n"),
          ...(issueUrl ? { replyMarkup: buildTelegramIssueKeyboard(issueUrl) } : {}),
          logger,
        });
        return ctx.text("", 200);
      }
    }

    if (!effectiveIdentity) {
      if (message.chat.type && message.chat.type !== "private") {
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: "Linking is only available in a direct message. Please DM me to link your account.",
          logger,
        });
        return ctx.text("", 200);
      }

      const pendingResult = await getTelegramLinkPending({
        userId: telegramUserId,
        logger,
      });
      if (!pendingResult.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: pendingResult.error,
          logger,
        });
        return ctx.text("", 200);
      }

      let pending = pendingResult.pending;
      if (pending && pending.expiresAtMs <= Date.now()) {
        await clearTelegramLinkPending({ userId: telegramUserId, logger });
        pending = null;
      }

      if (pending?.step === "awaiting_owner") {
        const ownerInput = parseGithubOwnerFromText(rawText);
        if (!ownerInput) {
          await safeSendTelegramMessage({
            botToken,
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            text: "Send just your GitHub owner (username or org), or paste a GitHub URL.",
            logger,
          });
          return ctx.text("", 200);
        }

        const issueResult = await initiateTelegramLinkIssue({
          env,
          code: pending.code,
          owner: ownerInput,
          logger,
          requestUrl: ctx.req.url,
        });
        if (!issueResult.ok) {
          const normalizedError = issueResult.error.toLowerCase();
          const shouldShowRecoveryKeyboard = normalizedError.includes("no github app installation found");
          if (normalizedError.includes("expired") || normalizedError.includes("link code already claimed")) {
            await clearTelegramLinkPending({ userId: telegramUserId, logger });
          }
          const lines = formatTelegramLinkError(issueResult.error, ownerInput);
          await safeSendTelegramMessage({
            botToken,
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            text: lines.join("\n"),
            ...(shouldShowRecoveryKeyboard ? { replyMarkup: buildTelegramLinkRecoveryKeyboard(ownerInput) } : {}),
            logger,
          });
          return ctx.text("", 200);
        }

        const pendingSave = await saveTelegramLinkPending({
          userId: telegramUserId,
          code: pending.code,
          step: "awaiting_close",
          expiresAtMs: pending.expiresAtMs,
          owner: ownerInput,
          logger,
        });
        if (!pendingSave.ok) {
          await safeSendTelegramMessage({
            botToken,
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            text: pendingSave.error,
            logger,
          });
          return ctx.text("", 200);
        }

        const createdLines = [
          `Link issue created for ${ownerInput}/.ubiquity-os.`,
          `Issue: ${issueResult.issueUrl}`,
          "",
          "Close the issue to approve.",
          "I'll DM you once it's linked.",
        ];
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: createdLines.join("\n"),
          replyMarkup: buildTelegramIssueKeyboard(issueResult.issueUrl),
          logger,
        });
        return ctx.text("", 200);
      }

      if (pending?.step === "awaiting_close" || pending?.step === "awaiting_reaction") {
        let issueUrl = "";
        const issueResult = await getTelegramLinkIssue({
          code: pending.code,
          logger,
        });
        if (issueResult.ok && issueResult.issue?.issueUrl) {
          issueUrl = issueResult.issue.issueUrl;
        }
        const waitingLines = [
          "Waiting for you to close the link issue.",
          issueUrl ? `Issue: ${issueUrl}` : "",
          "Close the issue and I'll DM you once linked.",
        ].filter(Boolean);
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: waitingLines.join("\n"),
          ...(issueUrl ? { replyMarkup: buildTelegramIssueKeyboard(issueUrl) } : {}),
          logger,
        });
        return ctx.text("", 200);
      }

      const introLines = [
        "This Telegram account isn't linked to a GitHub identity yet.",
        "",
        "Steps:",
        "1) Create a repository named `.ubiquity-os` under the owner you want to link.",
        "2) Install the UbiquityOS GitHub App on that repo (org-wide is best).",
        "3) Approve linking by closing the link issue.",
        "",
        "Config path: <owner>/.ubiquity-os/.github/.ubiquity-os.config.yml",
        "",
        `Tap ${TELEGRAM_START_LINKING_LABEL} to continue here in Telegram.`,
      ];

      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: introLines.join("\n"),
        replyMarkup: buildTelegramLinkingKeyboard(),
        logger,
      });
      return ctx.text("", 200);
    }

    await runTelegramWebhookIdentityFlow({
      botToken,
      env,
      logger,
      message,
      telegramUserId,
      commandName,
      invocation,
      effectiveIdentity,
      rawText,
      classificationText,
      stimulus,
      updateId: update.update_id,
      requestUrl: ctx.req.url,
      effectiveMessageThreadId,
      effectiveContextThreadId,
      loadWorkspaceByChatOnce,
      secrets,
    });
    return ctx.text("", 200);
  } finally {
    stopTyping();
  }
}
