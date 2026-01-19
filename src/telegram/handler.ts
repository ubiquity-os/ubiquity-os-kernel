import { EmitterWebhookEvent } from "@octokit/webhooks";
import { Context } from "hono";
import { GitHubContext } from "../github/github-context.ts";
import { GitHubEventHandler } from "../github/github-event-handler.ts";
import { describeCommands, parseSlashCommandParameters } from "../github/handlers/issue-comment-created.ts";
import { dispatchInternalAgent } from "../github/handlers/internal-agent.ts";
import { tryParseRouterDecision, type RouterDecision } from "../github/handlers/router-decision.ts";
import { buildRouterPrompt } from "../github/handlers/router-prompt.ts";
import { callPersonalAgent } from "../github/handlers/personal-agent.ts";
import { Env } from "../github/types/env.ts";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GithubPlugin, isGithubPlugin, parsePluginIdentifier } from "../github/types/plugin-configuration.ts";
import { PluginInput } from "../github/types/plugin.ts";
import { callUbqAiRouter } from "../github/utils/ai-router.ts";
import { CONFIG_ORG_REPO, getConfig } from "../github/utils/config.ts";
import { buildConversationContext } from "../github/utils/conversation-context.ts";
import { resolveConversationKeyForContext } from "../github/utils/conversation-graph.ts";
import { parseAgentConfig, parseAiConfig, parseKernelConfig, type AgentConfig, type AiConfig, type KernelConfig } from "../github/utils/env-config.ts";
import { parseGitHubAppConfig, type GitHubAppConfig } from "../github/utils/github-app-config.ts";
import { getKvClient, type KvKey, type KvLike } from "../github/utils/kv-client.ts";
import { getManifest } from "../github/utils/plugins.ts";
import { withKernelContextSettingsIfNeeded, withKernelContextWorkflowInputsIfNeeded } from "../github/utils/plugin-dispatch-settings.ts";
import { classifyTextIngress } from "../github/utils/reaction.ts";
import { getErrorReply } from "../github/utils/router-error-messages.ts";
import { updateRequestCommentRunUrl } from "../github/utils/request-comment-run-url.ts";
import { dispatchWorker, dispatchWorkflowWithRunUrl, getDefaultBranch } from "../github/utils/workflow-dispatch.ts";
import { logger as baseLogger } from "../logger/logger.ts";

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramChat = {
  id: number;
  type?: string;
  title?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type TelegramRoutingConfig = {
  owner?: string;
  repo?: string;
  issueNumber?: number;
  installationId?: number;
};

type TelegramMode = "github" | "shim";

type TelegramIngressConfig = TelegramRoutingConfig & {
  botToken: string;
  webhookSecret?: string;
  mode: TelegramMode;
};

type TelegramContextKind = "issue" | "repo" | "org";

type TelegramRoutingOverride = {
  kind: TelegramContextKind;
  owner: string;
  repo: string;
  issueNumber?: number;
  installationId?: number;
  sourceUrl?: string;
};

type PluginWithManifest = {
  target: string | GithubPlugin;
  settings: Record<string, unknown> | null | undefined;
  manifest: Manifest;
};

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SESSION_TITLE_MAX_CHARS = 120;
const TELEGRAM_SESSION_BODY_MAX_CHARS = 8000;
const TELEGRAM_SHIM_GITHUB_LOGIN = "0x4007";
const TELEGRAM_SHIM_ORG = "0x4007-ubiquity-os";
const TELEGRAM_ALLOWED_AUTHOR_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "NONE"];
// TODO: Swap this shim registry for org plugin-derived commands once GitHub wiring lands.
const TELEGRAM_SHIM_COMMANDS = [
  { name: "s", description: "Connect your account (stubbed).", example: "/s" },
  { name: "ping", description: "Check if the bot is alive.", example: "/ping" },
  {
    name: "context",
    description: "Set the active GitHub context (org, repo, or issue).",
    example: "/context https://github.com/ubiquity-os/.github-private/issues/8",
  },
  {
    name: "conversation_graph",
    description: "Show the conversation graph context for a query (filters bots/commands by default).",
    example: "/conversation_graph --all how does this issue relate to recent PRs?",
  },
  { name: "help", description: "List available commands.", example: "/help" },
];
const TELEGRAM_COMMAND_SYNC_MIN_INTERVAL_MS = 60_000;
const telegramCommandSyncState: { lastSignature?: string; lastSyncAt?: number } = {};
const TELEGRAM_CONTEXT_PREFIX: KvKey = ["ubiquityos", "telegram", "context"];
let telegramKvWarningIssued = false;

type Logger = typeof baseLogger;

export async function handleTelegramWebhook(ctx: Context, env: Env): Promise<Response> {
  const logger = ctx.var.logger ?? baseLogger;
  const configResult = parseTelegramConfig(env);
  if (!configResult.ok) {
    return ctx.json({ error: configResult.error }, configResult.status);
  }
  const config = configResult.config;
  const botToken = config.botToken;
  logger.info({ mode: config.mode }, "Telegram ingress request");

  if (config.webhookSecret) {
    const provided = ctx.req.header("x-telegram-bot-api-secret-token") ?? "";
    if (provided !== config.webhookSecret) {
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

  const message = getTelegramMessage(update);
  if (!message) {
    return ctx.json({ ok: true }, 200);
  }

  const rawText = getTelegramText(message);
  if (!rawText.trim()) {
    return ctx.json({ ok: true }, 200);
  }

  const classificationText = getClassificationText(rawText, message.chat);
  const stimulus = classifyTextIngress(classificationText);
  if (stimulus.reaction === "ignore") {
    return ctx.json({ ok: true }, 200);
  }

  const invocation = stimulus.reflex === "slash" ? stimulus.slashInvocation : null;
  if (invocation?.name?.toLowerCase() === "context") {
    const isHandled = await handleTelegramContextCommand({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      rawArgs: invocation.rawArgs,
      allowOverride: config.mode === "shim",
      logger,
    });
    if (isHandled) {
      return ctx.json({ ok: true }, 200);
    }
  }
  if (invocation) {
    const isHandled = await handleTelegramShimSlash({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      command: invocation.name,
      logger,
    });
    if (isHandled) {
      return ctx.json({ ok: true }, 200);
    }
  }

  let routingOverride = config.mode === "shim" ? await loadTelegramRoutingOverride({ botToken, chatId: message.chat.id, logger }) : null;
  if (config.mode === "shim" && !routingOverride) {
    void maybeSyncTelegramCommands({
      botToken,
      commands: TELEGRAM_SHIM_COMMANDS,
      logger,
    });
    if (invocation?.name.toLowerCase() === "help") {
      const help = formatHelpForTelegram(TELEGRAM_SHIM_COMMANDS);
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: help,
        logger,
      });
      return ctx.json({ ok: true }, 200);
    }
    if (invocation) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: "Set context with /context <github-repo-or-issue-url> before running commands.",
        logger,
      });
    }
    return ctx.json({ ok: true }, 200);
  }

  void safeSendTelegramChatAction({
    botToken,
    chatId: message.chat.id,
    action: "typing",
    logger,
  });

  const githubConfigResult = parseGitHubAppConfig(env);
  if (!githubConfigResult.ok) {
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: githubConfigResult.error,
      logger,
    });
    return ctx.json({ ok: true }, 200);
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
    return ctx.json({ ok: true }, 200);
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
    return ctx.json({ ok: true }, 200);
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
    return ctx.json({ ok: true }, 200);
  }

  const routing: TelegramRoutingConfig =
    config.mode === "shim"
      ? {
          owner: routingOverride?.owner,
          repo: routingOverride?.repo,
          issueNumber: routingOverride?.issueNumber,
          installationId: routingOverride?.installationId,
        }
      : {
          owner: config.owner,
          repo: config.repo,
          issueNumber: config.issueNumber,
          installationId: config.installationId,
        };

  const kernelRefreshUrl = new URL("/internal/agent/refresh-token", ctx.req.url).toString();
  const contextResult = await createGitHubContext({
    env,
    logger,
    updateId: update.update_id,
    message,
    rawText,
    kernelRefreshUrl,
    routing,
    githubConfig: githubConfigResult.config,
    aiConfig: aiConfigResult.config,
    agentConfig: agentConfigResult.config,
    kernelConfig: kernelConfigResult.config,
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
    return ctx.json({ ok: true }, 200);
  }

  let { context, pluginsWithManifest, manifests, hasIssueContext } = contextResult;
  const commands = describeCommands(manifests);
  const helpCommands = getTelegramHelpCommands(commands);
  void maybeSyncTelegramCommands({
    botToken,
    commands: helpCommands,
    logger,
  });
  if (stimulus.reaction === "reflex" && stimulus.reflex === "slash") {
    if (!invocation) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: "I couldn't understand that command. Try /help.",
        logger,
      });
      return ctx.json({ ok: true }, 200);
    }

    if (invocation.name.toLowerCase() === "help") {
      const help = formatHelpForTelegram(helpCommands);
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: help,
        logger,
      });
      return ctx.json({ ok: true }, 200);
    }

    const isConversationGraphCommand = ["conversation_graph", "conversation-graph"].includes(invocation.name.toLowerCase());
    if (isConversationGraphCommand) {
      if (config.mode === "shim" && !hasIssueContext) {
        const target = routingOverride ? describeTelegramContextLabel(routingOverride) : formatRoutingLabel(routing);
        const prefix = target ? `Context is set to ${target}. ` : "";
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: `${prefix}Use /context <github-issue-url> to generate a conversation graph.`,
          logger,
        });
        return ctx.json({ ok: true }, 200);
      }
      const graphArgs = parseConversationGraphArgs(invocation.rawArgs);
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
      return ctx.json({ ok: true }, 200);
    }

    const match = resolvePluginCommand(pluginsWithManifest, invocation.name);
    if (!match) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `I couldn't find a plugin for /${invocation.name}. Try /help.`,
        logger,
      });
      return ctx.json({ ok: true }, 200);
    }

    if (config.mode === "shim" && !hasIssueContext) {
      const ensured = await ensureTelegramIssueContext({
        context,
        routing,
        routingOverride,
        updateId: update.update_id,
        message,
        rawText,
        botToken,
        chatId: message.chat.id,
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
        return ctx.json({ ok: true }, 200);
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

    const parameters = parseSlashCommandParameters(invocation.name, invocation.rawArgs, match.manifest.commands?.[invocation.name]?.parameters, context);
    const isDispatched = await dispatchCommandPlugin(context, match, invocation.name, parameters ?? null);
    if (!isDispatched) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `I couldn't start /${invocation.name}.`,
        logger,
      });
      return ctx.json({ ok: true }, 200);
    }

    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: `Running /${invocation.name}.`,
      logger,
    });
    return ctx.json({ ok: true }, 200);
  }

  if (stimulus.reaction === "reflex" && stimulus.reflex === "personal_agent") {
    if (config.mode === "shim" && !hasIssueContext) {
      const ensured = await ensureTelegramIssueContext({
        context,
        routing,
        routingOverride,
        updateId: update.update_id,
        message,
        rawText,
        botToken,
        chatId: message.chat.id,
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
        return ctx.json({ ok: true }, 200);
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
    return ctx.json({ ok: true }, 200);
  }

  const conversationContext = hasIssueContext
    ? await buildTelegramConversationContext({ context, query: rawText, logger, maxItems: 8, maxChars: 3200, useSelector: true })
    : "";

  const decision = await getTelegramRouterDecision(context, {
    chat: message.chat,
    author: getTelegramAuthor(message),
    comment: classificationText,
    commands,
    conversationContext,
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
    return ctx.json({ ok: true }, 200);
  }

  if (decision.action === "ignore") {
    return ctx.json({ ok: true }, 200);
  }

  if (decision.action === "help") {
    const help = formatHelpForTelegram(helpCommands);
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: help,
      logger,
    });
    return ctx.json({ ok: true }, 200);
  }

  if (decision.action === "reply") {
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: decision.reply,
      logger,
    });
    return ctx.json({ ok: true }, 200);
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
      return ctx.json({ ok: true }, 200);
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
      return ctx.json({ ok: true }, 200);
    }

    if (config.mode === "shim" && !hasIssueContext) {
      const ensured = await ensureTelegramIssueContext({
        context,
        routing,
        routingOverride,
        updateId: update.update_id,
        message,
        rawText,
        botToken,
        chatId: message.chat.id,
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
        return ctx.json({ ok: true }, 200);
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

    const isDispatched = await dispatchCommandPlugin(context, match, commandName, decision.command?.parameters ?? null);
    if (!isDispatched) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `I couldn't start /${commandName}.`,
        logger,
      });
      return ctx.json({ ok: true }, 200);
    }

    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: `Running /${commandName}.`,
      logger,
    });
    return ctx.json({ ok: true }, 200);
  }

  if (decision.action === "agent") {
    if (config.mode === "shim" && !hasIssueContext) {
      const ensured = await ensureTelegramIssueContext({
        context,
        routing,
        routingOverride,
        updateId: update.update_id,
        message,
        rawText,
        botToken,
        chatId: message.chat.id,
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
        return ctx.json({ ok: true }, 200);
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
    const task = String(decision.task ?? "").trim() || rawText.trim();
    await safeSendTelegramMessage({
      botToken,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      text: "Starting agent run.",
      logger,
    });
    await dispatchInternalAgent(context, task, {
      postReply: (body) =>
        safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: body,
          logger,
        }),
      settingsOverrides: {
        allowedAuthorAssociations: TELEGRAM_ALLOWED_AUTHOR_ASSOCIATIONS,
      },
    });
    return ctx.json({ ok: true }, 200);
  }

  return ctx.json({ ok: true }, 200);
}

function getTelegramMessage(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.edited_message ?? null;
}

function getTelegramText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

function getClassificationText(rawText: string, chat: TelegramChat): string {
  const trimmed = rawText.trim();
  if (!trimmed) return trimmed;
  if (chat.type !== "private") return trimmed;
  if (trimmed.startsWith("/") || trimmed.startsWith("@")) return trimmed;
  // Treat private chats as implicit @ubiquityos.
  return `@ubiquityos ${trimmed}`;
}

function normalizeOptionalEnvValue(value?: string): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.trunc(parsed);
    return normalized > 0 ? normalized : undefined;
  }
  return undefined;
}

function normalizePositiveInt(value?: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function parseTelegramConfig(env: Env): { ok: true; config: TelegramIngressConfig } | { ok: false; status: number; error: string } {
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
    return { ok: false, status: 500, error: "UOS_TELEGRAM.botToken is required." };
  }
  const modeRaw = normalizeOptionalString(record.mode);
  const mode = (modeRaw ? modeRaw.toLowerCase() : "github") as TelegramMode;
  if (mode !== "github" && mode !== "shim") {
    return { ok: false, status: 500, error: "UOS_TELEGRAM.mode must be 'github' or 'shim'." };
  }
  const owner = normalizeOptionalString(record.owner) ?? (mode === "github" ? "ubiquity-os-marketplace" : undefined);
  const repo = normalizeOptionalString(record.repo) ?? (mode === "github" ? "ubiquity-os-marketplace" : undefined);
  const issueNumber = parseOptionalPositiveInt(record.issueNumber);
  if (mode === "github" && !issueNumber) {
    return { ok: false, status: 500, error: "UOS_TELEGRAM.issueNumber is required." };
  }
  const webhookSecret = normalizeOptionalString(record.webhookSecret);
  const installationId = parseOptionalPositiveInt(record.installationId);
  return {
    ok: true,
    config: {
      botToken,
      webhookSecret,
      mode,
      owner,
      repo,
      issueNumber,
      installationId,
    },
  };
}

function formatHelpForTelegram(commands: Array<{ name: string; description: string; example: string }>): string {
  if (!commands.length) return "No commands available.";
  const lines = ["Available commands:"];
  for (const command of commands) {
    const description = command.description?.trim() ?? "";
    const example = command.example?.trim() ?? "";
    const label = example && !example.startsWith("/") ? example : `/${command.name}`;
    const extra = example && label !== example ? ` Example: ${example}` : "";
    lines.push(`${label} - ${description}${extra}`.trim());
  }
  return lines.join("\n");
}

function getTelegramAuthor(message: TelegramMessage): string {
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

function formatTelegramChatLabel(chat: TelegramChat): string {
  const title = chat.title?.trim() ?? "";
  if (title) return title;
  const username = chat.username?.trim() ?? "";
  if (username) return `@${username}`;
  return `chat ${chat.id}`;
}

function buildTelegramSessionIssueTitle(author: string, chatLabel: string): string {
  const base = `Telegram session: @${author} (${chatLabel})`;
  return clampText(base, TELEGRAM_SESSION_TITLE_MAX_CHARS);
}

function buildTelegramSessionIssueBody(params: {
  author: string;
  chatLabel: string;
  chatId: number;
  messageId: number;
  sourceUrl?: string;
  rawText: string;
}): string {
  const bodyLines = [
    "Telegram ingress session.",
    `Chat: ${params.chatLabel} (${params.chatId}).`,
    `User: @${params.author}.`,
    `Message: ${params.messageId}.`,
    params.sourceUrl ? `Context: ${params.sourceUrl}` : null,
    "",
    "Initial message:",
    params.rawText.trim() || "(empty)",
  ].filter(Boolean);
  return clampText(bodyLines.join("\n"), TELEGRAM_SESSION_BODY_MAX_CHARS);
}

function clampText(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function normalizeLogin(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "")
    .slice(0, 39);
}

async function safeSendTelegramMessage(params: {
  botToken: string;
  chatId: number;
  replyToMessageId?: number;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
  disableNotification?: boolean;
  truncate?: boolean;
  logger: Logger;
}): Promise<number | null> {
  const { botToken, chatId, replyToMessageId, parseMode, disablePreview, disableNotification, truncate, logger } = params;
  const normalized = params.text.trim();
  if (!normalized) return null;
  const body = {
    chat_id: chatId,
    text: truncate === false ? normalized : truncateTelegramMessage(normalized),
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(disablePreview ? { disable_web_page_preview: true } : {}),
    ...(disableNotification ? { disable_notification: true } : {}),
  };

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.warn({ status: response.status, detail }, "Failed to send Telegram reply");
      return null;
    }
    const data = (await response.json().catch(() => null)) as { ok?: boolean; result?: { message_id?: number } } | null;
    return typeof data?.result?.message_id === "number" ? data.result.message_id : null;
  } catch (error) {
    logger.warn({ err: error }, "Failed to send Telegram reply");
    return null;
  }
}

async function safeSendTelegramChatAction(params: {
  botToken: string;
  chatId: number;
  action:
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
  logger: Logger;
}): Promise<void> {
  const { botToken, chatId, action, logger } = params;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.warn({ status: response.status, detail }, "Failed to send Telegram chat action");
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to send Telegram chat action");
  }
}

function truncateTelegramMessage(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
  const suffix = "...";
  return text.slice(0, TELEGRAM_MESSAGE_LIMIT - suffix.length) + suffix;
}

function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttribute(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

type ConversationGraphFilters = {
  includeBots: boolean;
  includeCommands: boolean;
};

type ConversationGraphPlan = {
  headerLines: string[];
  nodes: ConversationGraphNodePlan[];
};

type ConversationGraphNodePlan = {
  lines: string[];
  commentBlocks: string[][];
};

type ParsedConversationNode = {
  headerLine: string;
  url?: string;
  bodyLines: string[];
  comments: ParsedConversationComment[];
  section?: string;
};

type ParsedConversationComment = {
  headerLine: string;
  url?: string;
  bodyLines: string[];
};

function buildConversationGraphPlan(params: {
  conversationContext: string;
  query: string;
  filters: ConversationGraphFilters;
  maxNodes?: number;
  maxComments?: number;
}): ConversationGraphPlan {
  const headerLines: string[] = [];
  headerLines.push("<u><b>Conversation graph context</b></u>");
  headerLines.push(`Query: <code>${escapeTelegramHtml(params.query)}</code>`);
  const filterLabel = formatConversationFilterLabel(params.filters);
  if (filterLabel) {
    headerLines.push(`Filters: <i>${escapeTelegramHtml(filterLabel)}</i>`);
  }

  if (!params.conversationContext.trim()) {
    headerLines.push("");
    headerLines.push("No conversation graph data found for this context.");
    return { headerLines, nodes: [] };
  }

  const parsedNodes = parseConversationGraphNodes(params.conversationContext, params.filters);
  const limitedNodes = applyConversationGraphLimits(parsedNodes, params.maxNodes, params.maxComments);
  const nodes = limitedNodes.map(formatConversationGraphNodePlan);
  return { headerLines, nodes };
}

function applyConversationGraphLimits(
  nodes: ParsedConversationNode[],
  maxNodes?: number,
  maxComments?: number
): ParsedConversationNode[] {
  const normalizedNodes = normalizePositiveInt(maxNodes);
  const normalizedComments = normalizePositiveInt(maxComments);
  const limitedNodes = normalizedNodes ? nodes.slice(0, normalizedNodes) : nodes;
  if (!normalizedComments) return limitedNodes;
  return limitedNodes.map((node) => ({
    ...node,
    comments: node.comments.slice(0, normalizedComments),
  }));
}

function formatConversationGraphNodePlan(node: ParsedConversationNode): ConversationGraphNodePlan {
  const lines: string[] = [];
  const headerText = simplifyNodeHeader(node.headerLine);
  lines.push(formatConversationHeaderLink(headerText, node.url));
  const bodyLines = formatConversationGraphLinesFromRaw(node.bodyLines);
  if (bodyLines.length > 0) {
    lines.push("");
    lines.push(...bodyLines);
  }

  const commentBlocks = node.comments.map((comment) => {
    const commentLines: string[] = [];
    const commentHeader = simplifyCommentHeader(comment.headerLine);
    commentLines.push(formatConversationHeaderLink(commentHeader, comment.url));
    const formatted = formatConversationGraphLinesFromRaw(comment.bodyLines);
    if (formatted.length > 0) {
      commentLines.push("");
      commentLines.push(...formatted);
    }
    return commentLines;
  });

  return { lines, commentBlocks };
}

function parseConversationGraphNodes(conversationContext: string, filters: ConversationGraphFilters): ParsedConversationNode[] {
  const lines = conversationContext.split("\n");
  const nodes: ParsedConversationNode[] = [];
  let currentNode: ParsedConversationNode | null = null;
  let currentComment: ParsedConversationComment | null = null;
  let section: string | undefined;
  let inComments = false;

  const flushComment = () => {
    if (!currentComment || !currentNode) {
      currentComment = null;
      return;
    }
    const meta = parseCommentHeader(currentComment.headerLine);
    const blockLines = [currentComment.headerLine, ...currentComment.bodyLines];
    if (!shouldSkipCommentBlock(meta, blockLines, filters)) {
      currentNode.comments.push(currentComment);
    }
    currentComment = null;
  };

  const flushNode = () => {
    if (!currentNode) return;
    flushComment();
    if (currentNode.comments.length > 1) {
      currentNode.comments.reverse();
    }
    nodes.push(currentNode);
    currentNode = null;
    inComments = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isTopLevel = line.trimStart() === line;
    if (!trimmed) {
      if (currentComment) {
        currentComment.bodyLines.push("");
      } else if (currentNode) {
        currentNode.bodyLines.push("");
      }
      continue;
    }

    const heading = normalizeConversationHeading(trimmed);
    if (heading) {
      flushNode();
      section = heading;
      continue;
    }

    if (trimmed === "Comments:") {
      inComments = true;
      flushComment();
      continue;
    }

    if (isTopLevel && isNodeHeaderLine(trimmed)) {
      flushNode();
      currentNode = {
        headerLine: trimmed,
        url: undefined,
        bodyLines: [],
        comments: [],
        section,
      };
      inComments = false;
      continue;
    }

    if (!currentNode) {
      continue;
    }

    if (inComments) {
      const commentMeta = parseCommentHeader(trimmed);
      if (commentMeta) {
        flushComment();
        currentComment = {
          headerLine: trimmed,
          url: undefined,
          bodyLines: [],
        };
        continue;
      }

      const url = parseLeadingUrl(trimmed);
      if (url && !url.rest) {
        if (currentComment && !currentComment.url) {
          currentComment.url = url.url;
          continue;
        }
      }

      if (currentComment) {
        currentComment.bodyLines.push(stripConversationIndent(line, 4));
      } else {
        currentNode.bodyLines.push(stripConversationIndent(line, 2));
      }
      continue;
    }

    const url = parseLeadingUrl(trimmed);
    if (url && !url.rest && !currentNode.url) {
      currentNode.url = url.url;
      continue;
    }
    currentNode.bodyLines.push(stripConversationIndent(line, 2));
  }

  flushNode();
  return nodes;
}

function stripConversationIndent(line: string, maxSpaces: number): string {
  let trimmed = line;
  let count = 0;
  while (count < maxSpaces && trimmed.startsWith(" ")) {
    trimmed = trimmed.slice(1);
    count += 1;
  }
  return trimmed;
}

function isNodeHeaderLine(line: string): boolean {
  const match = /^-\s*\[([^\]]+)\]\s+/.exec(line);
  if (!match) return false;
  const label = normalizeConversationLabel(match[1]);
  return label === "Issue" || label === "PR";
}

function simplifyNodeHeader(line: string): string {
  const match = /^-\s*\[[^\]]+\]\s*(.+)$/.exec(line);
  const rest = match?.[1]?.trim() ?? line.trim();
  const [repoPart, ...titleParts] = rest.split(" - ");
  const repoLabel = repoPart.trim();
  const title = titleParts.join(" - ").trim();
  if (title) return `${repoLabel} — ${title}:`;
  return `${repoLabel}:`;
}

function simplifyCommentHeader(line: string): string {
  const meta = parseCommentHeader(line);
  const author = meta?.author ? `@${meta.author}` : "unknown";
  const date = extractDateFromLine(line);
  if (date) return `${author} on ${date}:`;
  return `${author}:`;
}

function extractDateFromLine(line: string): string {
  const match = /\b\d{4}-\d{2}-\d{2}\b/.exec(line);
  return match ? match[0] : "";
}

function formatConversationHeaderLink(text: string, url?: string): string {
  const escaped = escapeTelegramHtml(text);
  if (url) {
    const href = escapeTelegramHtmlAttribute(url);
    return `<u><b><a href="${href}">${escaped}</a></b></u>`;
  }
  return `<u><b>${escaped}</b></u>`;
}

function formatConversationGraphLinesFromRaw(rawLines: string[]): string[] {
  const lines: string[] = [];
  let pendingBullet: { index: number; label: string; text: string } | null = null;
  let inCodeBlock = false;
  let codeFence = "```";
  let codeBuffer: string[] = [];

  const emitLine = (rawLine: string) => {
    const trimmedRaw = rawLine.trimEnd();
    const trimmed = trimmedRaw.trim();
    if (inCodeBlock) {
      if (trimmed.startsWith(codeFence)) {
        const codeText = codeBuffer.join("\n");
        lines.push(`<pre><code>${escapeTelegramHtml(codeText)}</code></pre>`);
        inCodeBlock = false;
        codeBuffer = [];
        return;
      }
      codeBuffer.push(rawLine);
      return;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = true;
      codeFence = trimmed.slice(0, 3);
      codeBuffer = [];
      return;
    }
    if (!trimmed) {
      pendingBullet = null;
      if (lines[lines.length - 1] !== "") lines.push("");
      return;
    }
    const heading = normalizeConversationHeading(trimmed);
    if (heading) {
      pendingBullet = null;
      if (lines[lines.length - 1] !== "") lines.push("");
      lines.push(formatConversationHeadingLine(heading));
      return;
    }
    const bulletMatch = /^-\s*\[([^\]]+)\]\s*(.+)$/.exec(trimmed);
    if (bulletMatch) {
      const label = normalizeConversationLabel(bulletMatch[1]);
      const rest = bulletMatch[2].replace(/\s+-\s+/g, " — ");
      const text = formatConversationInline(rest);
      const line = `• <b>${escapeTelegramHtml(label)}</b> ${text}`.trim();
      lines.push(line);
      pendingBullet = { index: lines.length - 1, label, text: rest };
      return;
    }
    const leadingUrl = parseLeadingUrl(trimmed);
    if (leadingUrl && pendingBullet && !leadingUrl.rest) {
      const url = escapeTelegramHtmlAttribute(leadingUrl.url);
      const linkedText = formatConversationLinkText(pendingBullet.text);
      lines[pendingBullet.index] = `• <b>${escapeTelegramHtml(pendingBullet.label)}</b> <a href="${url}">${linkedText}</a>`;
      pendingBullet = null;
      return;
    }
    pendingBullet = null;
    if (trimmed.startsWith("matched by:")) {
      lines.push(`<i>${escapeTelegramHtml(trimmed)}</i>`);
      return;
    }
    const formatted = formatConversationBodyLine(trimmedRaw);
    if (!formatted) return;
    lines.push(formatted);
  };

  for (const raw of rawLines) {
    emitLine(raw);
  }
  if (inCodeBlock && codeBuffer.length > 0) {
    const codeText = codeBuffer.join("\n");
    lines.push(`<pre><code>${escapeTelegramHtml(codeText)}</code></pre>`);
  }
  return lines;
}

function parseConversationGraphArgs(rawArgs: string): { query: string; filters: ConversationGraphFilters } {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  let includeBots = false;
  let includeCommands = false;
  const queryTokens: string[] = [];
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === "--all" || normalized === "--raw") {
      includeBots = true;
      includeCommands = true;
      continue;
    }
    if (normalized === "--include-bots") {
      includeBots = true;
      continue;
    }
    if (normalized === "--include-commands") {
      includeCommands = true;
      continue;
    }
    queryTokens.push(token);
  }
  return {
    query: queryTokens.join(" ").trim(),
    filters: {
      includeBots,
      includeCommands,
    },
  };
}

function formatConversationInline(text: string): string {
  const parts = text.split("`");
  if (parts.length === 1) {
    return formatConversationInlineSegment(text);
  }
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1) {
      out.push(`<code>${escapeTelegramHtml(part)}</code>`);
    } else {
      out.push(formatConversationInlineSegment(part));
    }
  }
  return out.join("");
}

function formatConversationLinkText(text: string): string {
  return escapeTelegramHtml(text);
}

function formatConversationHeadingLine(heading: string): string {
  const escaped = escapeTelegramHtml(heading);
  return `<u><b>${escaped}</b></u>`;
}

function formatConversationBodyLine(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) {
    return `<span class="tg-spoiler">${escapeTelegramHtml(trimmed)}</span>`;
  }
  if (trimmed.startsWith(">")) {
    const quote = trimmed.replace(/^>\s?/, "");
    const formatted = formatConversationInline(quote);
    return `<blockquote>${formatted}</blockquote>`;
  }
  const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
  if (listMatch) {
    const formatted = formatConversationInline(listMatch[1]);
    return `• ${formatted}`;
  }
  return formatConversationInline(trimmed);
}

function formatConversationInlineSegment(raw: string): string {
  const segments = splitUrls(raw);
  if (!segments.length) return applyInlineStyles(escapeTelegramHtml(raw));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "url") {
      const href = escapeTelegramHtmlAttribute(segment.value);
      out.push(`<a href="${href}">${escapeTelegramHtml(segment.value)}</a>`);
    } else {
      out.push(applyInlineStyles(escapeTelegramHtml(segment.value)));
    }
  }
  return out.join("");
}

function splitUrls(raw: string): Array<{ kind: "text" | "url"; value: string }> {
  const regex = /https?:\/\/[^\s<>"']+/g;
  const segments: Array<{ kind: "text" | "url"; value: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      segments.push({ kind: "text", value: raw.slice(lastIndex, start) });
    }
    segments.push({ kind: "url", value: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < raw.length) {
    segments.push({ kind: "text", value: raw.slice(lastIndex) });
  }
  return segments;
}

function parseLeadingUrl(line: string): { url: string; rest: string } | null {
  const match = /^(https?:\/\/[^\s<>"']+)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return { url: match[1], rest: (match[2] ?? "").trim() };
}

function formatConversationFilterLabel(filters: ConversationGraphFilters): string {
  const hidden: string[] = [];
  if (!filters.includeBots) hidden.push("bots");
  if (!filters.includeCommands) hidden.push("command-only comments");
  if (hidden.length === 0) return "";
  return `hiding ${hidden.join(", ")}`;
}

function parseCommentHeader(line: string): { label: string; author?: string } | null {
  const match = /^-\s*\[([^\]]+)\]\s*(.+)$/.exec(line);
  if (!match) return null;
  const label = normalizeConversationLabel(match[1]);
  if (label !== "Comment" && label !== "Review" && label !== "Review Comment") return null;
  const meta = match[2] ?? "";
  const authorMatch = /@([^\s]+)/.exec(meta);
  const author = authorMatch?.[1];
  return { label, author };
}

function shouldSkipCommentBlock(
  meta: { label: string; author?: string } | null,
  blockLines: string[],
  filters: ConversationGraphFilters
): boolean {
  if (!meta) return false;
  if (!filters.includeBots && meta.author && isBotAuthor(meta.author)) return true;
  if (!filters.includeCommands && isCommandOnlyComment(blockLines)) return true;
  return false;
}

function isBotAuthor(author: string): boolean {
  const normalized = author.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("[bot]")) return true;
  if (normalized.endsWith("-bot") || normalized.endsWith("_bot")) return true;
  return false;
}

function isCommandOnlyComment(blockLines: string[]): boolean {
  const bodyLines = extractCommentBodyLines(blockLines);
  if (bodyLines.length === 0) return true;
  return bodyLines.every((line) => /^\/[\w-]+(\s|$)/.test(line));
}

function extractCommentBodyLines(blockLines: string[]): string[] {
  const body: string[] = [];
  for (let i = 1; i < blockLines.length; i += 1) {
    const trimmed = blockLines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) continue;
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) continue;
    if (/^<\/?[a-zA-Z][^>]*>$/.test(trimmed)) continue;
    body.push(trimmed);
  }
  return body;
}

function trimEmptyEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}

function applyInlineStyles(escaped: string): string {
  let styled = escaped;
  styled = styled.replace(/\|\|([^|]+)\|\|/g, '<span class="tg-spoiler">$1</span>');
  styled = styled.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  styled = styled.replace(/(^|\s)__([^_]+)__(?=\s|$)/g, "$1<u><b>$2</b></u>");
  styled = styled.replace(/(^|\s)\*\*([^*]+)\*\*(?=\s|$)/g, "$1<b>$2</b>");
  styled = styled.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1<i>$2</i>");
  styled = styled.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1<i>$2</i>");
  return styled;
}

function normalizeConversationHeading(value: string): string | null {
  const trimmed = value.replace(/:$/, "").trim();
  if (!trimmed) return null;
  if (
    trimmed === "Current thread" ||
    trimmed === "Conversation links (auto-merged)" ||
    trimmed === "Comments" ||
    trimmed === "Similar (semantic)"
  ) {
    return trimmed;
  }
  return null;
}

function normalizeConversationLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "Issue Comment") return "Comment";
  if (trimmed === "Review Comment") return "Review Comment";
  if (trimmed === "Review") return "Review";
  if (trimmed === "PullRequest") return "PR";
  return trimmed || "Item";
}

function splitTelegramMessageLines(lines: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (!line) {
      const extra = current.length ? 1 : 0;
      if (length + extra <= limit) {
        current.push("");
        length += extra;
        continue;
      }
      if (current.length) {
        chunks.push(current.join("\n"));
        current = [""];
        length = 0;
      }
      continue;
    }
    const lineLength = line.length;
    if (lineLength > limit) {
      if (current.length) {
        chunks.push(current.join("\n"));
        current = [];
        length = 0;
      }
      const suffix = "...";
      const truncated = line.slice(0, Math.max(0, limit - suffix.length)) + suffix;
      chunks.push(truncated);
      continue;
    }
    const extra = (current.length ? 1 : 0) + lineLength;
    if (length + extra > limit && current.length) {
      chunks.push(current.join("\n"));
      current = [line];
      length = lineLength;
      continue;
    }
    current.push(line);
    length = current.length === 1 ? lineLength : length + 1 + lineLength;
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

async function sendTelegramMessageChunked(params: {
  botToken: string;
  chatId: number;
  replyToMessageId?: number;
  lines: string[];
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
  disableNotification?: boolean;
  logger: Logger;
}): Promise<number | null> {
  const trimmed = trimEmptyEdges(params.lines);
  if (trimmed.length === 0) return null;
  const chunks = splitTelegramMessageLines(trimmed, TELEGRAM_MESSAGE_LIMIT);
  let firstMessageId: number | null = null;
  let threadId = params.replyToMessageId;
  for (const chunk of chunks) {
    const messageId = await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: threadId,
      text: chunk,
      parseMode: params.parseMode,
      disablePreview: params.disablePreview,
      disableNotification: params.disableNotification,
      truncate: false,
      logger: params.logger,
    });
    if (!firstMessageId && messageId) {
      firstMessageId = messageId;
      threadId = firstMessageId;
    } else if (firstMessageId) {
      threadId = firstMessageId;
    }
  }
  return firstMessageId;
}

async function sendTelegramConversationGraph(params: {
  botToken: string;
  chatId: number;
  replyToMessageId?: number;
  plan: ConversationGraphPlan;
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
  disableNotification?: boolean;
  logger: Logger;
}): Promise<void> {
  const headerId = await sendTelegramMessageChunked({
    botToken: params.botToken,
    chatId: params.chatId,
    replyToMessageId: params.replyToMessageId,
    lines: params.plan.headerLines,
    parseMode: params.parseMode,
    disablePreview: params.disablePreview,
    disableNotification: params.disableNotification,
    logger: params.logger,
  });

  for (const node of params.plan.nodes) {
    const nodeReplyTo = headerId ?? params.replyToMessageId;
    const nodeId = await sendTelegramMessageChunked({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: nodeReplyTo,
      lines: node.lines,
      parseMode: params.parseMode,
      disablePreview: params.disablePreview,
      disableNotification: params.disableNotification,
      logger: params.logger,
    });
    const commentReplyTo = nodeId ?? nodeReplyTo;
    for (const comment of node.commentBlocks) {
      await sendTelegramMessageChunked({
        botToken: params.botToken,
        chatId: params.chatId,
        replyToMessageId: commentReplyTo,
        lines: comment,
        parseMode: params.parseMode,
        disablePreview: params.disablePreview,
        disableNotification: params.disableNotification,
        logger: params.logger,
      });
    }
  }
}

async function safePinTelegramMessage(params: {
  botToken: string;
  chatId: number;
  messageId: number | null;
  logger: Logger;
}): Promise<void> {
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

async function createGitHubContext(params: {
  env: Env;
  logger: Logger;
  updateId: number;
  message: TelegramMessage;
  rawText: string;
  kernelRefreshUrl: string;
  routing: TelegramRoutingConfig;
  githubConfig: GitHubAppConfig;
  aiConfig: AiConfig;
  agentConfig: AgentConfig;
  kernelConfig: KernelConfig;
}): Promise<
  | {
      ok: true;
      context: GitHubContext<"issue_comment.created">;
      pluginsWithManifest: PluginWithManifest[];
      manifests: PluginWithManifest["manifest"][];
      hasIssueContext: boolean;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const { env, logger, updateId, message, rawText, kernelRefreshUrl, routing, githubConfig, aiConfig, agentConfig, kernelConfig } = params;
  const { owner, repo, issueNumber } = routing;
  if (!owner || !repo) {
    return { ok: false, error: "Missing Telegram routing configuration." };
  }
  const hasIssueContext = Number.isFinite(issueNumber) && Number(issueNumber) > 0;
  const normalizedIssueNumber = hasIssueContext ? Number(issueNumber) : 1;

  const eventHandler = new GitHubEventHandler({
    environment: env.ENVIRONMENT,
    webhookSecret: githubConfig.webhookSecret,
    appId: githubConfig.appId,
    privateKey: githubConfig.privateKey,
    llm: "gpt-5.2-chat-latest",
    aiBaseUrl: aiConfig.baseUrl,
    aiToken: aiConfig.token,
    kernelRefreshUrl,
    kernelRefreshIntervalSeconds: kernelConfig.refreshIntervalSeconds,
    agent: {
      owner: agentConfig.owner,
      repo: agentConfig.repo,
      workflowId: agentConfig.workflow,
      ref: agentConfig.ref,
    },
    logger,
  });

  const installationId = await resolveInstallationId(eventHandler, owner, repo, routing.installationId, logger);
  if (!installationId) {
    return { ok: false, error: "No GitHub App installation found for Telegram routing." };
  }

  const octokit = eventHandler.getAuthenticatedOctokit(installationId);
  const author = getTelegramAuthor(message);
  const issueTitleFallback = message.chat.title?.trim() || message.chat.username?.trim() || `Telegram chat ${message.chat.id}`;
  let issuePayload: Record<string, unknown> = {
    number: normalizedIssueNumber,
    title: issueTitleFallback,
    body: "",
    labels: [],
    user: { login: owner },
  };
  let issueTitle = issueTitleFallback;
  if (hasIssueContext) {
    const hydrated = await hydrateTelegramIssuePayload({
      octokit,
      owner,
      repo,
      issueNumber: normalizedIssueNumber,
      fallbackTitle: issueTitleFallback,
      logger,
    });
    if (hydrated) {
      issuePayload = hydrated.issue;
      issueTitle = hydrated.title;
    }
  }
  const payload = {
    action: "created",
    installation: { id: installationId },
    repository: { owner: { login: owner }, name: repo },
    issue: issuePayload,
    comment: {
      id: Number.isFinite(updateId) ? updateId : 0,
      body: rawText,
      user: { login: author, type: "User" },
      author_association: "NONE",
    },
    sender: { login: author, type: "User" },
  };
  const event = {
    id: `telegram-${updateId}`,
    name: "issue_comment",
    payload,
  } as unknown as EmitterWebhookEvent;
  const context = new GitHubContext(eventHandler, event, octokit, logger);

  const config = await getConfig(context);
  if (!config) {
    return { ok: false, error: "No kernel configuration was found for Telegram routing." };
  }

  const { pluginsWithManifest, manifests } = await loadPluginsWithManifest(context, config.plugins);
  return { ok: true, context, pluginsWithManifest, manifests, hasIssueContext };
}

type TelegramIssueCreation = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  persisted: boolean;
};

type EnsureTelegramIssueContextResult =
  | {
      ok: true;
      context: GitHubContext<"issue_comment.created">;
      hasIssueContext: true;
      createdIssue?: TelegramIssueCreation;
      routingOverride: TelegramRoutingOverride;
    }
  | {
      ok: false;
      error: string;
    };

async function ensureTelegramIssueContext(params: {
  context: GitHubContext<"issue_comment.created">;
  routing: TelegramRoutingConfig;
  routingOverride: TelegramRoutingOverride | null;
  updateId: number;
  message: TelegramMessage;
  rawText: string;
  botToken: string;
  chatId: number;
  logger: Logger;
}): Promise<EnsureTelegramIssueContextResult> {
  const owner = params.routing.owner?.trim();
  const repo = params.routing.repo?.trim();
  if (!owner || !repo) {
    return { ok: false, error: "Missing repo context; set it with /context <github-repo-url>." };
  }

  const installationId = params.context.payload.installation?.id;
  if (!installationId) {
    return { ok: false, error: "No GitHub App installation found for Telegram routing." };
  }

  try {
    const author = getTelegramAuthor(params.message);
    const chatLabel = formatTelegramChatLabel(params.message.chat);
    const title = buildTelegramSessionIssueTitle(author, chatLabel);
    const body = buildTelegramSessionIssueBody({
      author,
      chatLabel,
      chatId: params.message.chat.id,
      messageId: params.message.message_id,
      sourceUrl: params.routingOverride?.sourceUrl,
      rawText: params.rawText,
    });

    const issueResponse = await params.context.octokit.rest.issues.create({
      owner,
      repo,
      title,
      body,
    });
    const issueNumber = issueResponse.data.number ?? 0;
    if (!issueNumber) {
      return { ok: false, error: "Failed to create a Telegram session issue." };
    }

    const commentBody = params.rawText.trim() || "(empty)";
    const commentResponse = await params.context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: commentBody,
    });
    const commentId = commentResponse.data.id ?? 0;
    if (!commentId) {
      return { ok: false, error: "Failed to create a Telegram session comment." };
    }

    const issuePayload: Record<string, unknown> = {
      number: issueNumber,
      title: issueResponse.data.title ?? title,
      body: typeof issueResponse.data.body === "string" ? issueResponse.data.body : "",
      labels: Array.isArray(issueResponse.data.labels) ? issueResponse.data.labels : [],
      user: { login: issueResponse.data.user?.login ?? owner },
      node_id: issueResponse.data.node_id,
      html_url: issueResponse.data.html_url,
      url: issueResponse.data.url,
      created_at: issueResponse.data.created_at,
    };
    if (issueResponse.data.pull_request) {
      issuePayload.pull_request = issueResponse.data.pull_request;
    }

    const payload = {
      action: "created",
      installation: { id: installationId },
      repository: { owner: { login: owner }, name: repo },
      issue: issuePayload,
      comment: {
        id: commentId,
        body: commentBody,
        user: { login: author, type: "User" },
        author_association: "NONE",
      },
      sender: { login: author, type: "User" },
    };
    const event = {
      id: `telegram-${params.updateId}-${commentId}`,
      name: "issue_comment",
      payload,
    } as unknown as EmitterWebhookEvent;
    const context = new GitHubContext(params.context.eventHandler, event, params.context.octokit, params.logger);

    const issueUrl = issueResponse.data.html_url ?? buildIssueUrl({ owner, repo, issueNumber });
    const override: TelegramRoutingOverride = {
      kind: "issue",
      owner,
      repo,
      issueNumber,
      installationId,
      sourceUrl: issueUrl,
    };
    let persisted = false;
    const kv = await getTelegramKv(params.logger);
    if (kv) {
      persisted = await saveTelegramRoutingOverride({
        botToken: params.botToken,
        chatId: params.chatId,
        override,
        logger: params.logger,
        kv,
      });
    }

    return {
      ok: true,
      context,
      hasIssueContext: true,
      createdIssue: {
        owner,
        repo,
        number: issueNumber,
        url: issueUrl,
        persisted,
      },
      routingOverride: override,
    };
  } catch (error) {
    params.logger.warn({ err: error, owner, repo }, "Failed to create Telegram session issue");
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message ? `Failed to create a Telegram session issue: ${message}` : "Failed to create a Telegram session issue." };
  }
}

function buildTelegramIssueLink(issue: TelegramIssueCreation) {
  const label = `${issue.owner}/${issue.repo}#${issue.number}`;
  const link = `<a href="${escapeTelegramHtmlAttribute(issue.url)}">${escapeTelegramHtml(label)}</a>`;
  const suffix = issue.persisted ? "" : " Context wasn't saved; use /context to pin it.";
  return { message: `Opened issue ${link} for this session.${suffix}` };
}

async function hydrateTelegramIssuePayload(params: {
  octokit: GitHubContext["octokit"];
  owner: string;
  repo: string;
  issueNumber: number;
  fallbackTitle: string;
  logger: Logger;
}): Promise<{ issue: Record<string, unknown>; title: string } | null> {
  try {
    const { data } = await params.octokit.rest.issues.get({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
    });
    const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : params.fallbackTitle;
    const issue: Record<string, unknown> = {
      number: data.number ?? params.issueNumber,
      title,
      body: typeof data.body === "string" ? data.body : "",
      labels: Array.isArray(data.labels) ? data.labels : [],
      user: { login: data.user?.login ?? params.owner },
      node_id: data.node_id,
      html_url: data.html_url,
      url: data.url,
      created_at: data.created_at,
    };
    if (data.pull_request) {
      issue.pull_request = data.pull_request;
    }
    return { issue, title };
  } catch (error) {
    params.logger.debug({ err: error, owner: params.owner, repo: params.repo, issueNumber: params.issueNumber }, "Failed to hydrate Telegram issue payload");
    return null;
  }
}

async function handleTelegramShimSlash(params: {
  botToken: string;
  chatId: number;
  replyToMessageId: number;
  command: string;
  logger: Logger;
}): Promise<boolean> {
  const command = params.command.toLowerCase();
  if (command === "ping") {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "pong",
      logger: params.logger,
    });
    return true;
  }
  if (command === "s") {
    const message = [
      "Login is stubbed for now.",
      `GitHub identity: ${TELEGRAM_SHIM_GITHUB_LOGIN}`,
      `Org: ${TELEGRAM_SHIM_ORG}`,
      "Use /help to see available commands.",
    ].join("\n");
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: message,
      logger: params.logger,
    });
    return true;
  }
  return false;
}

function getTelegramHelpCommands(commands: Array<{ name: string; description: string; example: string }>) {
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

async function handleTelegramContextCommand(params: {
  botToken: string;
  chatId: number;
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
    const current = await loadTelegramRoutingOverride({ botToken: params.botToken, chatId: params.chatId, logger: params.logger, kv });
    const message = current
      ? `Current context: ${describeTelegramContextLabel(current)}\nSet a new one with /context <github-repo-or-issue-url>.`
      : "Usage: /context https://github.com/<owner>/<repo>/issues/<number> (or org/repo URL).";
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
      text: "Invalid GitHub URL. Example: /context https://github.com/ubiquity-os/.github-private/issues/8 or /context https://github.com/0x4007-ubiquity-os",
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
    override,
    logger: params.logger,
    kv,
  });

  if (!isSaved) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "I couldn't save that context. Please try again.",
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

async function maybeSyncTelegramCommands(params: { botToken: string; commands: Array<{ name: string; description: string }>; logger: Logger }): Promise<void> {
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

type ParsedGithubContext = {
  kind: TelegramContextKind;
  owner: string;
  repo?: string;
  issueNumber?: number;
  url: string;
};

function parseGithubContextFromText(value: string): ParsedGithubContext | null {
  const candidates = value
    .split(/\s+/)
    .map((candidate) => candidate.trim().replace(/^[<(]+|[>),.]+$/g, ""))
    .filter(Boolean);
  for (const candidate of candidates) {
    const parsed = tryParseGithubContextUrl(candidate) ?? tryParseGithubContextUrl(`https://${candidate}`);
    if (parsed) return parsed;
  }
  return null;
}

function tryParseGithubContextUrl(value: string): ParsedGithubContext | null {
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 1) {
      const owner = parts[0];
      return { kind: "org", owner, url: buildOrgUrl(owner) };
    }
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      if (parts.length >= 4) {
        const segment = (parts[2] ?? "").toLowerCase();
        if (segment === "issues" || segment === "pull" || segment === "pulls") {
          const issueNumber = Number(parts[3]);
          if (Number.isFinite(issueNumber) && issueNumber > 0) {
            return {
              kind: "issue",
              owner,
              repo,
              issueNumber: Math.trunc(issueNumber),
              url: buildIssueUrl({ owner, repo, issueNumber: Math.trunc(issueNumber) }),
            };
          }
        }
      }
      return { kind: "repo", owner, repo, url: buildRepoUrl(owner, repo) };
    }
    return null;
  } catch {
    return null;
  }
}

function buildIssueUrl(params: { owner: string; repo: string; issueNumber: number }): string {
  return `https://github.com/${params.owner}/${params.repo}/issues/${params.issueNumber}`;
}

function buildRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function buildOrgUrl(owner: string): string {
  return `https://github.com/${owner}`;
}

function buildTelegramRoutingOverride(context: ParsedGithubContext): TelegramRoutingOverride {
  if (context.kind === "org") {
    return {
      kind: "org",
      owner: context.owner,
      repo: CONFIG_ORG_REPO,
      sourceUrl: context.url,
    };
  }
  if (context.kind === "repo") {
    if (!context.repo) {
      throw new Error("Missing repo for Telegram repo context");
    }
    return {
      kind: "repo",
      owner: context.owner,
      repo: context.repo,
      sourceUrl: context.url,
    };
  }
  if (!context.repo || !context.issueNumber) {
    throw new Error("Missing issue context details");
  }
  return {
    kind: "issue",
    owner: context.owner,
    repo: context.repo,
    issueNumber: context.issueNumber,
    sourceUrl: context.url,
  };
}

function describeTelegramContext(override: TelegramRoutingOverride): string {
  if (override.kind === "issue" && override.issueNumber) {
    return `Context set to ${override.owner}/${override.repo}#${override.issueNumber}.`;
  }
  if (override.kind === "org") {
    return `Context set to org ${override.owner} (config: ${override.owner}/${CONFIG_ORG_REPO}). Send a message to start a session, or use /context <issue-url> to pin to a specific issue.`;
  }
  return `Context set to ${override.owner}/${override.repo}. Send a message to start a session, or use /context <issue-url> to pin to a specific issue.`;
}

function describeTelegramContextLabel(override: TelegramRoutingOverride): string {
  if (override.kind === "issue" && override.issueNumber) {
    return `${override.owner}/${override.repo}#${override.issueNumber}`;
  }
  if (override.kind === "org") {
    return `org ${override.owner}`;
  }
  return `${override.owner}/${override.repo}`;
}

function formatTelegramContextError(error: string, routing: TelegramRoutingConfig, environment: string): string {
  const normalized = error.trim();
  const target = formatRoutingLabel(routing);
  if (normalized.includes("No GitHub App installation found")) {
    return target
      ? `GitHub App is not installed for ${target}. Install it or use /context with another repo.`
      : "GitHub App is not installed for that repo. Install it or use /context with another repo.";
  }
  if (normalized.includes("No kernel configuration was found")) {
    const envLabel = environment?.trim() || "development";
    return target
      ? `No config found for ${target} (env: ${envLabel}). Add a .ubiquity-os config or import one.`
      : `No config found (env: ${envLabel}). Add a .ubiquity-os config or import one.`;
  }
  return normalized || "Telegram routing failed.";
}

function formatRoutingLabel(routing: TelegramRoutingConfig): string | null {
  const owner = routing.owner?.trim() ?? "";
  const repo = routing.repo?.trim() ?? "";
  const issueNumber = routing.issueNumber;
  if (!owner) return null;
  if (repo && Number.isFinite(issueNumber) && Number(issueNumber) > 0) {
    return `${owner}/${repo}#${Number(issueNumber)}`;
  }
  if (repo) {
    return `${owner}/${repo}`;
  }
  return owner;
}

async function getTelegramKv(logger: Logger): Promise<KvLike | null> {
  const kv = await getKvClient(logger);
  if (!kv && !telegramKvWarningIssued) {
    logger.warn({ feature: "telegram-context" }, "KV unavailable; Telegram context will not persist.");
    telegramKvWarningIssued = true;
  }
  return kv;
}

async function loadTelegramRoutingOverride(params: {
  botToken: string;
  chatId: number;
  logger: Logger;
  kv?: KvLike | null;
}): Promise<TelegramRoutingOverride | null> {
  const kv = params.kv ?? (await getTelegramKv(params.logger));
  if (!kv) return null;
  const key = getTelegramContextKey(params.botToken, params.chatId);
  const { value } = await kv.get(key);
  return parseTelegramRoutingOverride(value);
}

async function saveTelegramRoutingOverride(params: {
  botToken: string;
  chatId: number;
  override: TelegramRoutingOverride;
  logger: Logger;
  kv?: KvLike | null;
}): Promise<boolean> {
  const kv = params.kv ?? (await getTelegramKv(params.logger));
  if (!kv) return false;
  const key = getTelegramContextKey(params.botToken, params.chatId);
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

function getTelegramContextKey(botToken: string, chatId: number): KvKey {
  const botId = getTelegramBotId(botToken);
  return [...TELEGRAM_CONTEXT_PREFIX, botId, String(chatId)];
}

function getTelegramBotId(botToken: string): string {
  const trimmed = botToken.trim();
  const index = trimmed.indexOf(":");
  if (index > 0) {
    return trimmed.slice(0, index);
  }
  return trimmed || "unknown";
}

function parseTelegramRoutingOverride(value: unknown): TelegramRoutingOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kindRaw = normalizeOptionalString(record.kind);
  const owner = normalizeOptionalString(record.owner);
  const repo = normalizeOptionalString(record.repo);
  const issueNumber = parseOptionalPositiveInt(record.issueNumber);
  const kind =
    kindRaw === "org" || kindRaw === "repo" || kindRaw === "issue"
      ? (kindRaw as TelegramContextKind)
      : issueNumber
        ? "issue"
        : "repo";
  const resolvedRepo = repo ?? (kind === "org" ? CONFIG_ORG_REPO : undefined);
  if (!owner || !resolvedRepo) return null;
  if (kind === "issue" && !issueNumber) return null;
  const installationId = parseOptionalPositiveInt(record.installationId);
  const sourceUrl = normalizeOptionalString(record.sourceUrl);
  return {
    kind,
    owner,
    repo: resolvedRepo,
    ...(issueNumber ? { issueNumber } : {}),
    ...(installationId ? { installationId } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

async function resolveInstallationId(
  eventHandler: GitHubEventHandler,
  owner: string,
  repo: string,
  installationId: number | undefined,
  logger: Logger
): Promise<number | null> {
  if (installationId) return installationId;
  try {
    const appOctokit = eventHandler.getUnauthenticatedOctokit();
    const { data } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
    if (typeof data?.id === "number") return data.id;
  } catch (error) {
    logger.warn({ err: error, owner, repo }, "Failed to resolve GitHub App installation for Telegram routing");
  }
  return null;
}

async function loadPluginsWithManifest(
  context: GitHubContext<"issue_comment.created">,
  plugins: Record<string, Record<string, unknown> | null | undefined>
): Promise<{ pluginsWithManifest: PluginWithManifest[]; manifests: PluginWithManifest["manifest"][] }> {
  const isBotAuthor = context.payload.comment.user?.type !== "User";
  const pluginsWithManifest: PluginWithManifest[] = [];
  const manifests: PluginWithManifest["manifest"][] = [];

  for (const [pluginKey, pluginSettings] of Object.entries(plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    if (isBotAuthor && (pluginSettings as { skipBotEvents?: boolean })?.skipBotEvents) {
      continue;
    }
    const manifest = await getManifest(context, target);
    if (!manifest?.commands) continue;
    const entry = { target, settings: pluginSettings, manifest };
    pluginsWithManifest.push(entry);
    manifests.push(manifest);
  }
  return { pluginsWithManifest, manifests };
}

function resolvePluginCommand(pluginsWithManifest: PluginWithManifest[], commandName: string): PluginWithManifest | null {
  for (let i = pluginsWithManifest.length - 1; i >= 0; i--) {
    const candidate = pluginsWithManifest[i];
    if (candidate?.manifest?.commands?.[commandName] !== undefined) {
      return candidate;
    }
  }
  return null;
}

async function dispatchCommandPlugin(
  context: GitHubContext<"issue_comment.created">,
  match: PluginWithManifest,
  commandName: string,
  parameters: unknown
): Promise<boolean> {
  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    context.logger.warn("No installation found, cannot dispatch command");
    return false;
  }

  const command = { name: commandName, parameters };
  const plugin = match.target;
  const settings = withKernelContextSettingsIfNeeded(
    (match.settings as { with?: Record<string, unknown> } | undefined)?.with,
    plugin,
    context.eventHandler.environment
  );
  const isGithubPluginObject = isGithubPlugin(plugin);
  const stateId = crypto.randomUUID();
  const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
  const token = await context.eventHandler.getToken(context.payload.installation.id);
  const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, ref, command);

  context.logger.info({ plugin, isGithubPluginObject, command }, "Will dispatch command plugin.");
  try {
    if (!isGithubPluginObject) {
      await dispatchWorker(plugin, await inputs.getInputs());
    } else {
      const baseInputs = (await inputs.getInputs()) as Record<string, string>;
      const workflowInputs = await withKernelContextWorkflowInputsIfNeeded(baseInputs, plugin, () => context.eventHandler.getKernelPublicKeyPem());
      const runUrl = await dispatchWorkflowWithRunUrl(context, {
        owner: plugin.owner,
        repository: plugin.repo,
        workflowId: plugin.workflowId,
        ref,
        inputs: workflowInputs,
      });
      await updateRequestCommentRunUrl(context, runUrl);
    }
  } catch (error) {
    context.logger.error({ plugin, err: error }, "An error occurred while processing plugin; skipping plugin");
    return false;
  }

  return true;
}

async function getTelegramRouterDecision(
  context: GitHubContext<"issue_comment.created">,
  params: Readonly<{
    chat: TelegramChat;
    author: string;
    comment: string;
    commands: Array<{ name: string; description: string; example: string; parameters: unknown }>;
    conversationContext: string;
    onError: (message: string) => Promise<void>;
  }>
): Promise<RouterDecision | null> {
  const prompt = buildRouterPrompt({
    commands: params.commands,
    recentCommentsDescription: "array of recent Telegram messages: { id, author, body }",
    replyActionDescription: "send a Telegram message",
  });
  const routerInput = {
    repositoryOwner: context.payload.repository.owner.login,
    repositoryName: context.payload.repository.name,
    issueNumber: context.payload.issue.number,
    issueTitle: context.payload.issue.title,
    issueBody: context.payload.issue.body,
    isPullRequest: false,
    labels: [],
    recentComments: [
      {
        id: context.payload.comment.id ?? 0,
        author: params.author,
        body: params.comment,
      },
    ],
    agentMemory: "",
    conversationContext: params.conversationContext,
    author: params.author,
    comment: params.comment,
    platform: "telegram",
    chatId: params.chat.id,
    chatType: params.chat.type ?? "unknown",
  };

  try {
    const raw = await callUbqAiRouter(context, prompt, routerInput);
    const decision = tryParseRouterDecision(raw);
    if (!decision) {
      await params.onError("I couldn't understand that request. Try /help.");
      return null;
    }
    return decision;
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 0;
    const detail = error instanceof Error ? error.message : String(error);
    const message = getErrorReply(status, detail, "relatable");
    await params.onError(message);
    return null;
  }
}

async function buildTelegramConversationContext(params: {
  context: GitHubContext;
  query: string;
  logger: Logger;
  maxItems: number;
  maxChars: number;
  maxComments?: number;
  maxCommentChars?: number;
  includeComments?: boolean;
  includeSemantic?: boolean;
  useSelector: boolean;
}): Promise<string> {
  try {
    const conversation = await resolveConversationKeyForContext(params.context, params.logger);
    if (!conversation) return "";
    return await buildConversationContext({
      context: params.context,
      conversation,
      maxItems: params.maxItems,
      maxChars: params.maxChars,
      maxComments: params.maxComments,
      maxCommentChars: params.maxCommentChars,
      includeComments: params.includeComments,
      includeSemantic: params.includeSemantic,
      query: params.query,
      useSelector: params.useSelector,
    });
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to build Telegram conversation context");
    return "";
  }
}
