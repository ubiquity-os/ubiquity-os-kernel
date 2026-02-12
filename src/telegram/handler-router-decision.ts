import { type RouterDecision } from "../github/handlers/router-decision.ts";
import { type GitHubContext } from "../github/github-context.ts";
import { type TelegramMode } from "./channel-config.ts";
import { safeSendTelegramMessage } from "./api-client.ts";
import { type TelegramLinkedIdentity } from "./identity-store.ts";
import { buildTelegramIssueLink, ensureTelegramIssueContext } from "./handler-issue-context.ts";
import { dispatchCommandPlugin, resolvePluginCommand } from "./handler-plugin-router.ts";
import { maybeHandleTelegramAgentPlanningSession, startTelegramAgentPlanningSession } from "./handler-planning.ts";
import { type Logger, type PluginWithManifest, TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR, type TelegramMessage } from "./handler-shared.ts";
import { type TelegramRoutingConfig, type TelegramRoutingOverride } from "./routing-context.ts";

export async function handleTelegramRouterDecisionAction(params: {
  decision: RouterDecision;
  context: GitHubContext;
  botToken: string;
  message: TelegramMessage;
  telegramUserId: number;
  rawText: string;
  conversationContext: string;
  agentMemory: string;
  hasIssueContext: boolean;
  routing: TelegramRoutingConfig;
  routingOverride: TelegramRoutingOverride | null;
  channelMode: TelegramMode;
  actorIdentity: TelegramLinkedIdentity;
  updateId: number;
  effectiveContextThreadId: number | null;
  pluginsWithManifest: PluginWithManifest[];
  logger: Logger;
}): Promise<boolean> {
  const {
    decision,
    context,
    botToken,
    message,
    telegramUserId,
    rawText,
    conversationContext,
    agentMemory,
    hasIssueContext,
    routing,
    routingOverride,
    channelMode,
    actorIdentity,
    updateId,
    effectiveContextThreadId,
    pluginsWithManifest,
    logger,
  } = params;

  if (decision.action === "agent_plan") {
    const didHandlePlanningSession = await maybeHandleTelegramAgentPlanningSession({
      context,
      botToken,
      chat: message.chat,
      threadId: effectiveContextThreadId,
      userId: telegramUserId,
      replyToMessageId: message.message_id,
      rawText,
      conversationContext,
      agentMemory,
      routing,
      routingOverride,
      channelMode,
      actorIdentity,
      updateId: updateId,
      message,
      logger,
      hasIssueContext,
      intent: decision.operation,
    });
    if (!didHandlePlanningSession) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR,
        logger,
      });
    }
    return true;
  }

  if (decision.action === "command") {
    const commandName = decision.command?.name;
    if (!commandName || typeof commandName !== "string") {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: "I couldn't determine which command to run. Try /help.",
        logger,
      });
      return true;
    }

    const match = resolvePluginCommand(pluginsWithManifest, commandName);
    if (!match) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `I couldn't find a plugin for /${commandName}. Try /help.`,
        logger,
      });
      return true;
    }

    let dispatchContext = context;
    if (channelMode === "shim" && !hasIssueContext) {
      const ensured = await ensureTelegramIssueContext({
        context,
        routing,
        routingOverride,
        updateId: updateId,
        message,
        rawText,
        botToken,
        chatId: message.chat.id,
        threadId: effectiveContextThreadId ?? undefined,
        logger,
      });
      if (!ensured.ok) {
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: ensured.error,
          logger,
        });
        return true;
      }
      if (ensured.createdIssue) {
        const link = buildTelegramIssueLink(ensured.createdIssue);
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: link.message,
          parseMode: "HTML",
          disablePreview: true,
          logger,
        });
      }
      dispatchContext = ensured.context;
    }

    const isDispatched = await dispatchCommandPlugin(dispatchContext, match, commandName, decision.command?.parameters ?? null);
    if (!isDispatched) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `I couldn't start /${commandName}.`,
        logger,
      });
      return true;
    }

    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: `Running /${commandName}.`,
      logger,
    });
    return true;
  }

  if (decision.action === "agent") {
    const payload = context.payload as { issue?: { number?: number } };
    logger.info(
      {
        event: "telegram-agent",
        issueNumber: payload.issue?.number,
      },
      "Starting Telegram agent planning mode"
    );
    const request = String(decision.task ?? "").trim() || rawText.trim();
    await startTelegramAgentPlanningSession({
      context,
      botToken,
      chat: message.chat,
      threadId: effectiveContextThreadId,
      userId: telegramUserId,
      replyToMessageId: message.message_id,
      request,
      conversationContext,
      agentMemory,
      hasIssueContext,
      routing,
      routingOverride,
      logger,
    });
    return true;
  }

  return false;
}
