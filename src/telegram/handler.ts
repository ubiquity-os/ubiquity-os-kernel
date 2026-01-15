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
import { getConfig } from "../github/utils/config.ts";
import { parseAgentConfig, parseAiConfig, parseKernelConfig, type AgentConfig, type AiConfig, type KernelConfig } from "../github/utils/env-config.ts";
import { parseGitHubAppConfig, type GitHubAppConfig } from "../github/utils/github-app-config.ts";
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

type TelegramRoutingOverride = {
  owner: string;
  repo: string;
  issueNumber: number;
  installationId?: number;
  sourceUrl?: string;
};

type PluginWithManifest = {
  target: string | GithubPlugin;
  settings: Record<string, unknown> | null | undefined;
  manifest: Manifest;
};

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SHIM_GITHUB_LOGIN = "0x4007";
const TELEGRAM_SHIM_ORG = "0x4007-ubiquity-os";
// TODO: Swap this shim registry for org plugin-derived commands once GitHub wiring lands.
const TELEGRAM_SHIM_COMMANDS = [
  { name: "start", description: "Connect your account (stubbed).", example: "/start" },
  { name: "ping", description: "Check if the bot is alive.", example: "/ping" },
  {
    name: "context",
    description: "Set the active GitHub issue context.",
    example: "/context https://github.com/ubiquity-os/.github-private/issues/8",
  },
  { name: "help", description: "List available commands.", example: "/help" },
];
const TELEGRAM_COMMAND_SYNC_MIN_INTERVAL_MS = 60_000;
const telegramCommandSyncState: { lastSignature?: string; lastSyncAt?: number } = {};
const telegramRoutingOverrides = new Map<number, TelegramRoutingOverride>();

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

  if (config.mode === "shim") {
    const override = telegramRoutingOverrides.get(message.chat.id);
    if (!override) {
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
          text: "Set context with /context <github-issue-url> before running commands.",
          logger,
        });
      }
      return ctx.json({ ok: true }, 200);
    }
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

  const routingOverride = config.mode === "shim" ? telegramRoutingOverrides.get(message.chat.id) : null;
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

  const { context, pluginsWithManifest, manifests } = contextResult;
  const commands = describeCommands(manifests);
  const helpCommands = getTelegramHelpCommands(commands);
  void maybeSyncTelegramCommands({
    botToken,
    commands: helpCommands,
    logger,
  });
  if (config.mode === "shim" && (stimulus.reaction !== "reflex" || stimulus.reflex !== "slash")) {
    return ctx.json({ ok: true }, 200);
  }
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

  if (config.mode === "shim") {
    return ctx.json({ ok: true }, 200);
  }

  if (stimulus.reaction === "reflex" && stimulus.reflex === "personal_agent") {
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

  const decision = await getTelegramRouterDecision(context, {
    chat: message.chat,
    author: getTelegramAuthor(message),
    comment: classificationText,
    commands,
    onError: (text) =>
      safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text,
        logger,
      }),
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

function normalizeLogin(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "")
    .slice(0, 39);
}

async function safeSendTelegramMessage(params: { botToken: string; chatId: number; replyToMessageId?: number; text: string; logger: Logger }): Promise<void> {
  const { botToken, chatId, replyToMessageId, logger } = params;
  const normalized = params.text.trim();
  if (!normalized) return;
  const body = {
    chat_id: chatId,
    text: truncateTelegramMessage(normalized),
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
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
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to send Telegram reply");
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
    }
  | {
      ok: false;
      error: string;
    }
> {
  const { env, logger, updateId, message, rawText, kernelRefreshUrl, routing, githubConfig, aiConfig, agentConfig, kernelConfig } = params;
  const { owner, repo, issueNumber } = routing;
  if (!owner || !repo || !Number.isFinite(issueNumber) || issueNumber <= 0) {
    return { ok: false, error: "Missing Telegram routing configuration." };
  }

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
  const issueTitle = message.chat.title?.trim() || message.chat.username?.trim() || `Telegram chat ${message.chat.id}`;
  const payload = {
    action: "created",
    installation: { id: installationId },
    repository: { owner: { login: owner }, name: repo },
    issue: {
      number: issueNumber,
      title: issueTitle,
      body: "",
      labels: [],
      user: { login: owner },
    },
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
  return { ok: true, context, pluginsWithManifest, manifests };
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
  if (command === "start") {
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

  const rawArgs = params.rawArgs.trim();
  if (!rawArgs) {
    const current = telegramRoutingOverrides.get(params.chatId);
    const currentUrl =
      current && current.owner && current.repo && current.issueNumber
        ? buildIssueUrl({ owner: current.owner, repo: current.repo, issueNumber: current.issueNumber })
        : null;
    const message = currentUrl
      ? `Current context: ${currentUrl}\nSet a new one with /context <github-issue-url>.`
      : "Usage: /context https://github.com/<owner>/<repo>/issues/<number>";
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: message,
      logger: params.logger,
    });
    return true;
  }

  const parsed = parseGithubIssueUrlFromText(rawArgs);
  if (!parsed) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "Invalid GitHub issue URL. Example: /context https://github.com/ubiquity-os/.github-private/issues/8",
      logger: params.logger,
    });
    return true;
  }

  telegramRoutingOverrides.set(params.chatId, {
    owner: parsed.owner,
    repo: parsed.repo,
    issueNumber: parsed.issueNumber,
    sourceUrl: parsed.url,
  });

  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chatId,
    replyToMessageId: params.replyToMessageId,
    text: `Context set to ${parsed.owner}/${parsed.repo}#${parsed.issueNumber}.`,
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

function parseGithubIssueUrlFromText(value: string): { owner: string; repo: string; issueNumber: number; url: string } | null {
  const candidates = value
    .split(/\s+/)
    .map((candidate) => candidate.trim().replace(/^[<(]+|[>),.]+$/g, ""))
    .filter(Boolean);
  for (const candidate of candidates) {
    const parsed = tryParseGithubIssueUrl(candidate) ?? tryParseGithubIssueUrl(`https://${candidate}`);
    if (parsed) return parsed;
  }
  return null;
}

function tryParseGithubIssueUrl(value: string): { owner: string; repo: string; issueNumber: number; url: string } | null {
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;
    const owner = parts[0];
    const repo = parts[1];
    const segment = (parts[2] ?? "").toLowerCase();
    if (segment !== "issues" && segment !== "pull" && segment !== "pulls") return null;
    const issueNumber = Number(parts[3]);
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) return null;
    const normalized = buildIssueUrl({ owner, repo, issueNumber });
    return { owner, repo, issueNumber: Math.trunc(issueNumber), url: normalized };
  } catch {
    return null;
  }
}

function buildIssueUrl(params: { owner: string; repo: string; issueNumber: number }): string {
  return `https://github.com/${params.owner}/${params.repo}/issues/${params.issueNumber}`;
}

function formatTelegramContextError(error: string, routing: TelegramRoutingConfig, environment: string): string {
  const normalized = error.trim();
  const target = formatRoutingTarget(routing);
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

function formatRoutingTarget(routing: TelegramRoutingConfig): string | null {
  const owner = routing.owner?.trim() ?? "";
  const repo = routing.repo?.trim() ?? "";
  const issueNumber = routing.issueNumber;
  if (!owner || !repo || !Number.isFinite(issueNumber) || issueNumber <= 0) return null;
  return `${owner}/${repo}#${issueNumber}`;
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
    conversationContext: "",
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
