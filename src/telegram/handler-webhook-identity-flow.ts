import { describeCommands, parseSlashCommandParameters } from "../github/handlers/issue-comment-created.ts";
import { callPersonalAgent } from "../github/handlers/personal-agent.ts";
import { parseLeadingSlashCommand } from "../github/utils/slash-command.ts";
import { type Env } from "../github/types/env.ts";
import { parseAgentConfig, parseAiConfig, parseKernelConfig } from "../github/utils/env-config.ts";
import { parseGitHubAppConfig } from "../github/utils/github-app-config.ts";
import { CONFIG_ORG_REPO } from "../github/utils/config.ts";
import { parseTelegramChannelConfig } from "./channel-config.ts";
import { safeSendTelegramMessage, safeSendTelegramMessageWithFallback, TELEGRAM_MESSAGE_LIMIT } from "./api-client.ts";
import { buildConversationGraphPlan, parseConversationGraphArgs, sendTelegramConversationGraph } from "./conversation-graph-render.ts";
import { buildOrgUrl, describeTelegramContextLabel, formatRoutingLabel, type TelegramRoutingConfig } from "./routing-context.ts";
import { type TelegramLinkedIdentity } from "./identity-store.ts";
import { loadTelegramWorkspaceByChat } from "./workspace-store.ts";
import { createGitHubContext, loadKernelConfigForOwner } from "./handler-context-loader.ts";
import { buildTelegramIssueLink, ensureTelegramIssueContext, handleTelegramShimSlash, handleTelegramStatusCommand } from "./handler-issue-context.ts";
import { buildTelegramAgentPlanningKey, loadTelegramAgentPlanningSession } from "./agent-planning.ts";
import { dispatchCommandPlugin, getTelegramAgentMemorySnippet, getTelegramRouterDecision, resolvePluginCommand } from "./handler-plugin-router.ts";
import { buildTelegramConversationContext, maybeHandleTelegramAgentPlanningSession, parseTelegramAgentPlanningKeyword } from "./handler-planning.ts";
import { handleTelegramRouterDecisionAction } from "./handler-router-decision.ts";
import {
  formatTelegramContextError,
  getTelegramBotId,
  getTelegramHelpCommands,
  getTelegramKv,
  handleTelegramTopicCommand,
  loadTelegramRoutingOverride,
  maybeAutoRouteTelegramWorkspaceMessageToTopic,
  maybeSyncTelegramCommands,
} from "./handler-routing.ts";
import { handleTelegramWorkspaceBootstrapCommand } from "./handler-workspace-bootstrap.ts";
import {
  type Logger,
  normalizeTelegramUserCommandName,
  TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR,
  TELEGRAM_SHIM_COMMANDS,
  type TelegramMessage,
  type TelegramSecretsConfig,
} from "./handler-shared.ts";
import { escapeTelegramHtml, formatHelpForTelegram, getTelegramAuthor } from "./formatting.ts";

export async function runTelegramWebhookIdentityFlow(params: {
  botToken: string;
  env: Env;
  logger: Logger;
  message: TelegramMessage;
  telegramUserId: number;
  commandName: string | undefined;
  invocation: { name: string; rawArgs: string } | null;
  effectiveIdentity: TelegramLinkedIdentity;
  rawText: string;
  classificationText: string;
  stimulus: {
    reaction: string;
    reflex?: string | null;
  };
  updateId: number;
  requestUrl: string;
  effectiveMessageThreadId: number | null;
  effectiveContextThreadId: number | null;
  loadWorkspaceByChatOnce: () => Promise<Awaited<ReturnType<typeof loadTelegramWorkspaceByChat>> | null>;
  secrets: TelegramSecretsConfig;
}): Promise<boolean> {
  const {
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
    updateId,
    requestUrl,
    loadWorkspaceByChatOnce,
    secrets,
  } = params;
  let effectiveMessageThreadId = params.effectiveMessageThreadId;
  let effectiveContextThreadId = params.effectiveContextThreadId;

  const effectiveOwner = effectiveIdentity.owner;
  const parsedRawSlash = parseLeadingSlashCommand(rawText);
  const effectiveInvocation =
    invocation ??
    (parsedRawSlash
      ? {
          name: normalizeTelegramUserCommandName(parsedRawSlash.name),
          rawArgs: parsedRawSlash.rawArgs,
        }
      : null);
  let effectiveCommandName: string | undefined;
  if (commandName) {
    effectiveCommandName = normalizeTelegramUserCommandName(commandName);
  } else if (effectiveInvocation) {
    effectiveCommandName = normalizeTelegramUserCommandName(effectiveInvocation.name);
  }

  if (effectiveCommandName === "_status") {
    await handleTelegramStatusCommand({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      userId: telegramUserId,
      identity: effectiveIdentity,
      isPrivate: message.chat.type === "private",
      logger,
    });
    return true;
  }

  const githubConfigResult = parseGitHubAppConfig(env);
  if (!githubConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: githubConfigResult.error,
      logger,
    });
    return true;
  }
  const aiConfigResult = parseAiConfig(env.UOS_AI);
  if (!aiConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: aiConfigResult.error,
      logger,
    });
    return true;
  }
  const agentConfigResult = parseAgentConfig(env.UOS_AGENT);
  if (!agentConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: agentConfigResult.error,
      logger,
    });
    return true;
  }
  const kernelConfigResult = parseKernelConfig(env.UOS_KERNEL);
  if (!kernelConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: kernelConfigResult.error,
      logger,
    });
    return true;
  }

  const kernelRefreshUrl = new URL("/internal/agent/refresh-token", requestUrl).toString();
  const kernelConfigLoad = await loadKernelConfigForOwner({
    owner: effectiveOwner,
    env,
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
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: kernelConfigLoad.error,
      logger,
    });
    return true;
  }

  const channelConfigResult = parseTelegramChannelConfig(kernelConfigLoad.config, { fallbackOwner: effectiveOwner });
  if (!channelConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: channelConfigResult.error,
      logger,
    });
    return true;
  }
  const channelConfig = channelConfigResult.config;
  logger.info(
    {
      mode: channelConfig.mode,
      owner: channelConfig.owner,
      repo: channelConfig.repo,
    },
    "Telegram ingress request"
  );

  if (effectiveCommandName === "workspace" && effectiveInvocation) {
    const isHandled = await handleTelegramWorkspaceBootstrapCommand({
      botToken,
      chat: message.chat,
      userId: telegramUserId,
      replyToMessageId: message.message_id,
      allowWorkspace: channelConfig.mode === "shim",
      secrets,
      owner: effectiveOwner,
      logger,
    });
    if (isHandled) {
      return true;
    }
  }

  if (effectiveCommandName === "topic" && effectiveInvocation) {
    const isHandled = await handleTelegramTopicCommand({
      botToken,
      chat: message.chat,
      replyToMessageId: message.message_id,
      messageThreadId: effectiveMessageThreadId,
      rawArgs: effectiveInvocation.rawArgs,
      allowOverride: channelConfig.mode === "shim",
      logger,
    });
    if (isHandled) {
      return true;
    }
  }

  if (effectiveInvocation) {
    const isHandled = await handleTelegramShimSlash({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      command: effectiveCommandName ?? effectiveInvocation.name,
      logger,
    });
    if (isHandled) {
      return true;
    }
  }

  let routingOverride =
    channelConfig.mode === "shim"
      ? await loadTelegramRoutingOverride({
          botToken,
          chatId: message.chat.id,
          threadId: effectiveContextThreadId ?? undefined,
          logger,
        })
      : null;
  if (channelConfig.mode === "shim" && !routingOverride) {
    const owner = channelConfig.owner;
    const isPrivateChat = message.chat.type === "private";

    if (isPrivateChat) {
      // DMs default to the linked owner's personal config repo until /topic is set.
      routingOverride = {
        kind: "org",
        owner,
        repo: CONFIG_ORG_REPO,
        sourceUrl: buildOrgUrl(owner),
      };
    } else {
      const workspace = await loadWorkspaceByChatOnce();
      if (workspace) {
        // Workspace chats default to the linked owner's org config context until a topic/chat override is set.
        routingOverride = {
          kind: "org",
          owner,
          repo: CONFIG_ORG_REPO,
          sourceUrl: buildOrgUrl(owner),
        };
      } else {
        void maybeSyncTelegramCommands({
          botToken,
          commands: TELEGRAM_SHIM_COMMANDS,
          logger,
        });
        if (effectiveCommandName === "help") {
          const help = formatHelpForTelegram(TELEGRAM_SHIM_COMMANDS);
          const helpText = ["<b>Context</b>: not set. Use <code>/topic &lt;github-issue-or-repo-url&gt;</code> to load repo commands.", help]
            .filter(Boolean)
            .join("\n\n");
          const helpMessageId = await safeSendTelegramMessageWithFallback({
            botToken,
            chatId: message.chat.id,
            messageThreadId: effectiveMessageThreadId ?? undefined,
            replyToMessageId: message.message_id,
            text: helpText,
            parseMode: "HTML",
            disablePreview: true,
            logger,
          });
          if (!helpMessageId) {
            logger.warn({ command: "help", chatId: message.chat.id }, "Failed to send Telegram help response.");
          }
          return true;
        }
        if (effectiveInvocation) {
          await safeSendTelegramMessage({
            botToken,
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            text: "Set context with /topic <github-repo-or-issue-url> before running commands.",
            logger,
          });
        }
        return true;
      }
    }
  }

  if (channelConfig.mode === "shim" && !effectiveInvocation) {
    const autoRouteResult = await maybeAutoRouteTelegramWorkspaceMessageToTopic({
      botToken,
      chat: message.chat,
      messageThreadId: effectiveContextThreadId,
      replyToMessageId: message.message_id,
      rawText,
      userId: telegramUserId,
      currentOverride: routingOverride,
      logger,
    });
    if (autoRouteResult.mode === "handled") {
      return true;
    }
    if (autoRouteResult.mode === "switched") {
      routingOverride = autoRouteResult.override;
      effectiveMessageThreadId = autoRouteResult.threadId;
      effectiveContextThreadId = autoRouteResult.threadId;
      if (autoRouteResult.anchorMessageId) {
        message.message_id = autoRouteResult.anchorMessageId;
      }
      message.message_thread_id = autoRouteResult.threadId;
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

  const contextResult = await createGitHubContext({
    env,
    logger,
    updateId: updateId,
    message,
    rawText,
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
    const messageText = formatTelegramContextError(contextResult.error, routing, env.ENVIRONMENT);
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: messageText,
      logger,
    });
    return true;
  }

  let { context, hasIssueContext } = contextResult;
  const { pluginsWithManifest, manifests, pluginSummary } = contextResult;
  const commands = describeCommands(manifests);
  const helpCommands = getTelegramHelpCommands(commands);
  void maybeSyncTelegramCommands({
    botToken,
    commands: helpCommands,
    logger,
  });
  if (stimulus.reaction === "reflex" && stimulus.reflex === "slash") {
    if (!effectiveInvocation) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: "I couldn't understand that command. Try /help.",
        logger,
      });
      return true;
    }

    const planningKeyword = parseTelegramAgentPlanningKeyword(rawText);
    if (planningKeyword) {
      const planningAgentMemory = await getTelegramAgentMemorySnippet({
        context,
        query: rawText,
        hasIssueContext,
        logger,
      });
      const didHandlePlanningSlash = await maybeHandleTelegramAgentPlanningSession({
        context,
        botToken,
        chat: message.chat,
        threadId: effectiveContextThreadId,
        userId: telegramUserId,
        replyToMessageId: message.message_id,
        rawText,
        conversationContext: "",
        agentMemory: planningAgentMemory,
        routing,
        routingOverride,
        channelMode: channelConfig.mode,
        actorIdentity: effectiveIdentity,
        updateId: updateId,
        message,
        logger,
        hasIssueContext,
        intent: planningKeyword,
      });
      if (didHandlePlanningSlash) {
        return true;
      }
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR,
        logger,
      });
      return true;
    }

    if (effectiveCommandName === "help") {
      const headerLines: string[] = [];
      const target = routingOverride ? describeTelegramContextLabel(routingOverride) : formatRoutingLabel(routing);
      if (target) {
        headerLines.push(`Context: ${target}.`);
      }
      if (!commands.length) {
        if (pluginSummary.total > 0) {
          const summaryParts = ["No slash commands found.", `Plugins enabled: ${pluginSummary.total}`];
          if (pluginSummary.missingManifest > 0) {
            summaryParts.push(`missing manifests: ${pluginSummary.missingManifest}`);
          }
          if (pluginSummary.noCommands > 0) {
            summaryParts.push(`no-command plugins: ${pluginSummary.noCommands}`);
          }
          if (pluginSummary.invalid > 0) {
            summaryParts.push(`invalid plugins: ${pluginSummary.invalid}`);
          }
          headerLines.push(summaryParts.join(" "));
        } else {
          headerLines.push(target ? `No plugin commands found for ${target}.` : "No plugin commands found.");
        }
      }
      const help = formatHelpForTelegram(helpCommands);
      const escapedHeader = headerLines.map((line) => `<i>${escapeTelegramHtml(line)}</i>`);
      const helpText = escapedHeader.length ? `${escapedHeader.join("\n")}\n\n${help}` : help;
      const helpMessageId = await safeSendTelegramMessageWithFallback({
        botToken,
        chatId: message.chat.id,
        messageThreadId: effectiveMessageThreadId ?? undefined,
        replyToMessageId: message.message_id,
        text: helpText,
        parseMode: "HTML",
        disablePreview: true,
        logger,
      });
      if (!helpMessageId) {
        logger.warn({ command: "help", chatId: message.chat.id }, "Failed to send Telegram help response.");
      }
      return true;
    }

    const isConversationGraphCommand = effectiveCommandName === "_conversation_graph";
    if (isConversationGraphCommand) {
      if (channelConfig.mode === "shim" && !hasIssueContext) {
        const target = routingOverride ? describeTelegramContextLabel(routingOverride) : formatRoutingLabel(routing);
        const prefix = target ? `Context is set to ${target}. ` : "";
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: `${prefix}Use /topic <github-issue-url> to generate a conversation graph.`,
          logger,
        });
        return true;
      }
      const graphArgs = parseConversationGraphArgs(effectiveInvocation.rawArgs);
      const query = graphArgs.query;
      const graphDisplayMaxNodes = 40;
      const graphDisplayMaxComments = 40;
      const graphFetchMaxNodes = graphDisplayMaxNodes * 2;
      const graphFetchMaxComments = graphDisplayMaxComments * 3;
      const graphMaxChars = 300_000;
      const conversationContext = await buildTelegramConversationContext({
        context,
        query,
        logger,
        maxItems: graphFetchMaxNodes,
        maxChars: graphMaxChars,
        maxComments: graphFetchMaxComments,
        maxCommentChars: TELEGRAM_MESSAGE_LIMIT,
        useSelector: false,
      });
      const plan = buildConversationGraphPlan({
        conversationContext,
        query: query || "(none, showing full graph)",
        filters: graphArgs.filters,
        maxNodes: graphDisplayMaxNodes,
        maxComments: graphDisplayMaxComments,
      });
      await sendTelegramConversationGraph({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        plan,
        parseMode: "HTML",
        disablePreview: true,
        disableNotification: true,
        logger,
      });
      return true;
    }

    const match = resolvePluginCommand(pluginsWithManifest, effectiveInvocation.name);
    if (!match) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `I couldn't find a plugin for /${effectiveInvocation.name}. Try /help.`,
        logger,
      });
      return true;
    }

    if (channelConfig.mode === "shim" && !hasIssueContext) {
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
      context = ensured.context;
      hasIssueContext = true;
      routingOverride = ensured.routingOverride;
    }

    const parameters = parseSlashCommandParameters(
      effectiveInvocation.name,
      effectiveInvocation.rawArgs,
      match.manifest.commands?.[effectiveInvocation.name]?.parameters,
      context
    );
    const isDispatched = await dispatchCommandPlugin(context, match, effectiveInvocation.name, parameters ?? null);
    if (!isDispatched) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `I couldn't start /${effectiveInvocation.name}.`,
        logger,
      });
      return true;
    }

    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: `Running /${effectiveInvocation.name}.`,
      logger,
    });
    return true;
  }

  if (stimulus.reaction === "reflex" && stimulus.reflex === "personal_agent") {
    if (channelConfig.mode === "shim" && !hasIssueContext) {
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
      context = ensured.context;
      hasIssueContext = true;
      routingOverride = ensured.routingOverride;
    }
    const isDispatched = await callPersonalAgent(context);
    const response = isDispatched ? "Personal agent dispatched." : "No personal agent is registered for that username.";
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: response,
      logger,
    });
    return true;
  }

  const conversationContext = hasIssueContext
    ? await buildTelegramConversationContext({
        context,
        query: rawText,
        logger,
        maxItems: 8,
        maxChars: 3200,
        useSelector: true,
      })
    : "";
  const agentMemory = await getTelegramAgentMemorySnippet({
    context,
    query: classificationText,
    hasIssueContext,
    logger,
  });

  const planningKv = await getTelegramKv(logger);
  const planningKey = planningKv
    ? buildTelegramAgentPlanningKey({
        botId: getTelegramBotId(botToken),
        chatId: message.chat.id,
        threadId: effectiveContextThreadId,
        userId: telegramUserId,
      })
    : null;
  const agentPlanningSession =
    planningKv && planningKey
      ? await loadTelegramAgentPlanningSession({
          kv: planningKv,
          key: planningKey,
          logger,
        })
      : null;

  // Treat APPROVE/FINALIZE/CANCEL as explicit planning commands even if the router
  // would otherwise decide this message is unrelated.
  const planningKeyword = agentPlanningSession ? parseTelegramAgentPlanningKeyword(rawText) : null;
  if (planningKeyword) {
    const didHandleKeyword = await maybeHandleTelegramAgentPlanningSession({
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
      channelMode: channelConfig.mode,
      actorIdentity: effectiveIdentity,
      updateId: updateId,
      message,
      logger,
      hasIssueContext,
      intent: planningKeyword,
    });
    if (didHandleKeyword) {
      return true;
    }
  }

  const decision = await getTelegramRouterDecision(context, {
    chat: message.chat,
    author: getTelegramAuthor(message),
    comment: classificationText,
    commands,
    conversationContext,
    agentMemory,
    agentPlanningSession,
    onError: async (text) => {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text,
        logger,
      });
    },
  });

  if (!decision) {
    return true;
  }

  if (decision.action === "ignore") {
    return true;
  }

  if (decision.action === "help") {
    const help = formatHelpForTelegram(helpCommands);
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: help,
      parseMode: "HTML",
      disablePreview: true,
      logger,
    });
    return true;
  }

  if (decision.action === "reply") {
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: decision.reply,
      logger,
    });
    return true;
  }

  await handleTelegramRouterDecisionAction({
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
    channelMode: channelConfig.mode,
    actorIdentity: effectiveIdentity,
    updateId,
    effectiveContextThreadId,
    pluginsWithManifest,
    logger,
  });

  return true;
}
