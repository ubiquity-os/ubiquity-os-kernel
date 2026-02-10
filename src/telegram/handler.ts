import { EmitterWebhookEvent } from "@octokit/webhooks";
import { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { GitHubContext } from "../github/github-context.ts";
import { GitHubEventHandler } from "../github/github-event-handler.ts";
import { describeCommands, parseSlashCommandParameters } from "../github/handlers/issue-comment-created.ts";
import { dispatchInternalAgent } from "../github/handlers/internal-agent.ts";
import { type RouterDecision, tryParseRouterDecision } from "../github/handlers/router-decision.ts";
import { buildRouterPrompt } from "../github/handlers/router-prompt.ts";
import { callPersonalAgent } from "../github/handlers/personal-agent.ts";
import { Env } from "../github/types/env.ts";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GithubPlugin, isGithubPlugin, parsePluginIdentifier } from "../github/types/plugin-configuration.ts";
import { PluginInput } from "../github/types/plugin.ts";
import { callUbqAiRouter } from "../github/utils/ai-router.ts";
import { CONFIG_ORG_REPO, getConfig, getConfigurationFromRepo } from "../github/utils/config.ts";
import { buildConversationContext } from "../github/utils/conversation-context.ts";
import { resolveConversationKeyForContext } from "../github/utils/conversation-graph.ts";
import { type AgentConfig, type AiConfig, type KernelConfig, parseAgentConfig, parseAiConfig, parseKernelConfig } from "../github/utils/env-config.ts";
import { type GitHubAppConfig, parseGitHubAppConfig } from "../github/utils/github-app-config.ts";
import { getKvClient, type KvKey, type KvLike } from "../github/utils/kv-client.ts";
import { getManifest } from "../github/utils/plugins.ts";
import { withKernelContextSettingsIfNeeded, withKernelContextWorkflowInputsIfNeeded } from "../github/utils/plugin-dispatch-settings.ts";
import { classifyTextIngress } from "../github/utils/reaction.ts";
import { getErrorReply } from "../github/utils/router-error-messages.ts";
import { updateRequestCommentRunUrl } from "../github/utils/request-comment-run-url.ts";
import { dispatchWorker, dispatchWorkflowWithRunUrl, getDefaultBranch } from "../github/utils/workflow-dispatch.ts";
import { logger as baseLogger } from "../logger/logger.ts";
import { parseTelegramChannelConfig } from "./channel-config.ts";
import {
  clearTelegramLinkPending,
  getOrCreateTelegramLinkCode,
  getTelegramLinkedIdentity,
  getTelegramLinkIssue,
  getTelegramLinkPending,
  saveTelegramLinkPending,
  type TelegramLinkedIdentity,
} from "./identity-store.ts";
import { claimTelegramWorkspace, loadTelegramWorkspaceByChat, loadTelegramWorkspaceByUser, unclaimTelegramWorkspace } from "./workspace-store.ts";
import {
  deleteTelegramWorkspaceBootstrap,
  loadTelegramWorkspaceBootstrapByChat,
  loadTelegramWorkspaceBootstrapByUser,
  saveTelegramWorkspaceBootstrap,
} from "./workspace-bootstrap-store.ts";
import { initiateTelegramLinkIssue } from "./link.ts";
import { createTelegramWorkspaceForumSupergroup } from "./workspace-bootstrap.ts";
import { configSchema } from "../github/types/plugin-configuration.ts";
import type { PluginConfiguration } from "../github/types/plugin-configuration.ts";
import { Value } from "@sinclair/typebox/value";
import {
  buildTelegramAgentPlanningKey,
  buildTelegramAgentPlanningPrompt,
  deleteTelegramAgentPlanningSession,
  loadTelegramAgentPlanningSession,
  parseTelegramAgentPlanningSession,
  saveTelegramAgentPlanningSession,
  tryParseTelegramAgentPlanningOutput,
  type TelegramAgentPlanningDraft,
  type TelegramAgentPlanningSession,
} from "./agent-planning.ts";
import { getOrBuildTelegramRepoNotes } from "./repo-notes.ts";

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
  is_forum?: boolean;
};

type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;
  chat: TelegramChat;
};

type TelegramChatMember = {
  user: TelegramUser;
  status?: string;
};

type TelegramChatMemberUpdated = {
  chat: TelegramChat;
  from?: TelegramUser;
  date?: number;
  old_chat_member?: TelegramChatMember;
  new_chat_member?: TelegramChatMember;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: TelegramChatMemberUpdated;
  chat_member?: TelegramChatMemberUpdated;
};

type TelegramRoutingConfig = {
  owner?: string;
  repo?: string;
  issueNumber?: number;
  installationId?: number;
};

type TelegramSecretsConfig = {
  botToken: string;
  webhookSecret?: string;
  apiId?: number;
  apiHash?: string;
  userSession?: string;
  // Telegram file_id (not URL) to use for workspace group avatars.
  // Using a file_id is extremely efficient: no image assets stored in the repo and no uploads per group.
  workspacePhotoFileId?: string;
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

type PluginCommandSummary = {
  total: number;
  withCommands: number;
  missingManifest: number;
  noCommands: number;
  invalid: number;
  skippedBotEvents: number;
};

function mergePluginConfigurations(base: PluginConfiguration, override: PluginConfiguration): PluginConfiguration {
  const mergedPlugins = {
    ...(base.plugins ?? {}),
    ...(override.plugins ?? {}),
  };
  return {
    ...base,
    ...override,
    plugins: mergedPlugins,
  };
}

type TelegramInlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
  // Telegram Bot API 9.4+: optional button style (color).
  style?: "danger" | "success" | "primary";
};

type TelegramReplyMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

const TELEGRAM_GENERAL_TOPIC_ID = 1;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SESSION_TITLE_MAX_CHARS = 120;
const TELEGRAM_SESSION_BODY_MAX_CHARS = 8000;
const TELEGRAM_FORUM_TOPIC_NAME_MAX_CHARS = 128;
const TELEGRAM_FORUM_TOPIC_CREATE_ERROR = "Couldn't create a topic.";
const TELEGRAM_TYPING_INTERVAL_MS = 4500;
const TELEGRAM_AGENT_PLANNING_CALLBACK_PREFIX = "uos_agent_plan";
const TELEGRAM_LINK_RETRY_CALLBACK_PREFIX = "link:retry:";
const TELEGRAM_LINK_START_CALLBACK_DATA = "link:start";
const TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR = "No active plan found.";
const TELEGRAM_START_LINKING_LABEL = "Start linking";
const TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION = "not enough rights";
const TELEGRAM_ALLOWED_AUTHOR_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "NONE"];
const TELEGRAM_CONTEXT_SAVE_ERROR = "I couldn't save that context. Please try again.";
// TODO: Swap this shim registry for org plugin-derived commands once GitHub wiring lands.
const TELEGRAM_SHIM_COMMANDS = [
  {
    name: "_status",
    description: "Developer: check account link status.",
    example: "/_status",
  },
  { name: "_ping", description: "Developer: check if the bot is alive.", example: "/_ping" },
  {
    name: "workspace",
    description: "Create a new workspace group (Topics enabled). DM-only.",
    example: "/workspace",
  },
  {
    name: "topic",
    description: "Set the active GitHub context (org, repo, or issue). In workspaces, creates/updates a topic.",
    example: "/topic https://github.com/ubiquity-os/ubiquity-os-kernel/issues/1",
  },
  {
    name: "_conversation_graph",
    description: "Developer: show the conversation graph context for a query (filters bots/commands by default).",
    example: "/_conversation_graph --all how does this issue relate to recent PRs?",
  },
  { name: "help", description: "List available commands.", example: "/help" },
];
const TELEGRAM_COMMAND_SYNC_MIN_INTERVAL_MS = 60_000;
const TELEGRAM_AGENT_PLANNING_TTL_MS = 30 * 60_000;
const TELEGRAM_AGENT_PLANNING_MAX_ANSWERS = 12;
const TELEGRAM_AGENT_TASK_MAX_CHARS = 40_000;
const telegramCommandSyncState: {
  lastSignature?: string;
  lastSyncAt?: number;
} = {};
const TELEGRAM_CONTEXT_PREFIX: KvKey = ["ubiquityos", "telegram", "context"];
let hasTelegramKvWarningIssued = false;

type Logger = typeof baseLogger;

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
      logger.info({ chatId: message.chat.id, userId: leftMemberId, event: "telegram-left-member" }, "Telegram left_chat_member event");
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
          logger.warn({ err: error, chatId: message.chat.id, userId: telegramUserId }, "Failed to scan Telegram agent planning sessions (non-fatal)");
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
              messageThreadId: messageThreadId ?? undefined,
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
    messageThreadId: messageThreadId ?? undefined,
    action: "typing",
    logger,
  });
  try {
    const invocation = stimulus.reflex === "slash" ? stimulus.slashInvocation : null;
    const commandName = invocation?.name?.toLowerCase();
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
    if (commandName === "status") {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: "Command renamed: use /_status.",
        logger,
      });
      return ctx.text("", 200);
    }
    if (commandName === "_status") {
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

    const effectiveOwner = effectiveIdentity.owner;

    const githubConfigResult = parseGitHubAppConfig(env);
    if (!githubConfigResult.ok) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: githubConfigResult.error,
        logger,
      });
      return ctx.text("", 200);
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
      return ctx.text("", 200);
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
      return ctx.text("", 200);
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
      return ctx.text("", 200);
    }

    const kernelRefreshUrl = new URL("/internal/agent/refresh-token", ctx.req.url).toString();
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
      return ctx.text("", 200);
    }

    const channelConfigResult = parseTelegramChannelConfig(kernelConfigLoad.config, effectiveOwner);
    if (!channelConfigResult.ok) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: channelConfigResult.error,
        logger,
      });
      return ctx.text("", 200);
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

    if (commandName === "workspace" && invocation) {
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
        return ctx.text("", 200);
      }
    }

    // Removed legacy commands: ignore silently (no users yet, avoid UX noise).
    if ((commandName === "claim" || commandName === "unclaim") && invocation) {
      return ctx.text("", 200);
    }

    if (commandName === "topic" && invocation) {
      const isHandled = await handleTelegramTopicCommand({
        botToken,
        chat: message.chat,
        replyToMessageId: message.message_id,
        messageThreadId,
        rawArgs: invocation.rawArgs,
        allowOverride: channelConfig.mode === "shim",
        logger,
      });
      if (isHandled) {
        return ctx.text("", 200);
      }
    }

    if (commandName === "context" && invocation) {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        messageThreadId: messageThreadId ?? undefined,
        replyToMessageId: message.message_id,
        text: "Command renamed: use /topic.",
        logger,
      });
      return ctx.text("", 200);
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
        return ctx.text("", 200);
      }
    }

    let routingOverride =
      channelConfig.mode === "shim"
        ? await loadTelegramRoutingOverride({
            botToken,
            chatId: message.chat.id,
            threadId: contextThreadId ?? undefined,
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
          if (invocation?.name.toLowerCase() === "help") {
            const help = formatHelpForTelegram(TELEGRAM_SHIM_COMMANDS);
            const envLabel = env.ENVIRONMENT?.trim() || "development";
            const configNotice = kernelConfigLoad.hasConfig ? null : `No config found for ${effectiveOwner} (env: ${envLabel}).`;
            const helpText = [configNotice, "Context: not set. Use /topic <github-issue-or-repo-url> to load repo commands.", help]
              .filter(Boolean)
              .join("\n\n");
            const helpMessageId = await safeSendTelegramMessageWithFallback({
              botToken,
              chatId: message.chat.id,
              messageThreadId: messageThreadId ?? undefined,
              replyToMessageId: message.message_id,
              text: helpText,
              logger,
            });
            if (!helpMessageId) {
              logger.warn({ command: "help", chatId: message.chat.id }, "Failed to send Telegram help response.");
            }
            return ctx.text("", 200);
          }
          if (invocation) {
            await safeSendTelegramMessage({
              botToken,
              chatId: message.chat.id,
              replyToMessageId: message.message_id,
              text: "Set context with /topic <github-repo-or-issue-url> before running commands.",
              logger,
            });
          }
          return ctx.text("", 200);
        }
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
      updateId: update.update_id,
      message,
      rawText,
      kernelRefreshUrl,
      routing,
      actorIdentity: identityResult.identity,
      githubConfig: githubConfigResult.config,
      aiConfig: aiConfigResult.config,
      agentConfig: agentConfigResult.config,
      kernelConfig: kernelConfigResult.config,
      kernelConfigOverride: undefined,
      fallbackOwner: effectiveOwner,
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
      return ctx.text("", 200);
    }

    let { context, hasIssueContext } = contextResult;
    const { pluginsWithManifest, manifests, pluginSummary, didUseFallbackConfig, fallbackOwner, hasTargetConfig } = contextResult;
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
        return ctx.text("", 200);
      }

      const planningKeyword = parseTelegramAgentPlanningKeyword(rawText);
      if (planningKeyword) {
        const didHandlePlanningSlash = await maybeHandleTelegramAgentPlanningSession({
          context,
          botToken,
          chat: message.chat,
          threadId: contextThreadId,
          userId: telegramUserId,
          replyToMessageId: message.message_id,
          rawText,
          conversationContext: "",
          routing,
          routingOverride,
          channelMode: channelConfig.mode,
          updateId: update.update_id,
          message,
          logger,
          hasIssueContext,
          intent: planningKeyword,
        });
        if (didHandlePlanningSlash) {
          return ctx.text("", 200);
        }
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR,
          logger,
        });
        return ctx.text("", 200);
      }

      if (invocation.name.toLowerCase() === "help") {
        const headerLines: string[] = [];
        const target = routingOverride ? describeTelegramContextLabel(routingOverride) : formatRoutingLabel(routing);
        const envLabel = env.ENVIRONMENT?.trim() || "development";
        if (target) {
          headerLines.push(`Context: ${target}.`);
        }
        if (target && !hasTargetConfig) {
          if (didUseFallbackConfig && fallbackOwner) {
            headerLines.push(`No config found for ${target} (env: ${envLabel}). Using ${fallbackOwner} defaults.`);
          } else {
            headerLines.push(`No config found for ${target} (env: ${envLabel}).`);
          }
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
        const helpText = headerLines.length ? `${headerLines.join("\n")}\n\n${help}` : help;
        const helpMessageId = await safeSendTelegramMessageWithFallback({
          botToken,
          chatId: message.chat.id,
          messageThreadId: messageThreadId ?? undefined,
          replyToMessageId: message.message_id,
          text: helpText,
          logger,
        });
        if (!helpMessageId) {
          logger.warn({ command: "help", chatId: message.chat.id }, "Failed to send Telegram help response.");
        }
        return ctx.text("", 200);
      }

      const normalizedInvocation = invocation.name.toLowerCase();
      if (normalizedInvocation === "conversation_graph" || normalizedInvocation === "conversation-graph") {
        await safeSendTelegramMessage({
          botToken,
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          text: "Command renamed: use /_conversation_graph.",
          logger,
        });
        return ctx.text("", 200);
      }
      const isConversationGraphCommand = normalizedInvocation === "_conversation_graph";
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
          return ctx.text("", 200);
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
        return ctx.text("", 200);
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
        return ctx.text("", 200);
      }

      if (channelConfig.mode === "shim" && !hasIssueContext) {
        const ensured = await ensureTelegramIssueContext({
          context,
          routing,
          routingOverride,
          updateId: update.update_id,
          message,
          rawText,
          botToken,
          chatId: message.chat.id,
          threadId: contextThreadId ?? undefined,
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
          return ctx.text("", 200);
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
        return ctx.text("", 200);
      }

      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `Running /${invocation.name}.`,
        logger,
      });
      return ctx.text("", 200);
    }

    if (stimulus.reaction === "reflex" && stimulus.reflex === "personal_agent") {
      if (channelConfig.mode === "shim" && !hasIssueContext) {
        const ensured = await ensureTelegramIssueContext({
          context,
          routing,
          routingOverride,
          updateId: update.update_id,
          message,
          rawText,
          botToken,
          chatId: message.chat.id,
          threadId: contextThreadId ?? undefined,
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
          return ctx.text("", 200);
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
      return ctx.text("", 200);
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

    const planningKv = await getTelegramKv(logger);
    const planningKey = planningKv
      ? buildTelegramAgentPlanningKey({
          botId: getTelegramBotId(botToken),
          chatId: message.chat.id,
          threadId: contextThreadId,
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
        threadId: contextThreadId,
        userId: telegramUserId,
        replyToMessageId: message.message_id,
        rawText,
        conversationContext,
        routing,
        routingOverride,
        channelMode: channelConfig.mode,
        updateId: update.update_id,
        message,
        logger,
        hasIssueContext,
        intent: planningKeyword,
      });
      if (didHandleKeyword) {
        return ctx.text("", 200);
      }
    }

    const decision = await getTelegramRouterDecision(context, {
      chat: message.chat,
      author: getTelegramAuthor(message),
      comment: classificationText,
      commands,
      conversationContext,
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
      return ctx.text("", 200);
    }

    if (decision.action === "agent_plan") {
      const didHandlePlanningSession = await maybeHandleTelegramAgentPlanningSession({
        context,
        botToken,
        chat: message.chat,
        threadId: contextThreadId,
        userId: telegramUserId,
        replyToMessageId: message.message_id,
        rawText,
        conversationContext,
        routing,
        routingOverride,
        channelMode: channelConfig.mode,
        updateId: update.update_id,
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
      return ctx.text("", 200);
    }

    if (decision.action === "ignore") {
      return ctx.text("", 200);
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
      return ctx.text("", 200);
    }

    if (decision.action === "reply") {
      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: decision.reply,
        logger,
      });
      return ctx.text("", 200);
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
        return ctx.text("", 200);
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
        return ctx.text("", 200);
      }

      if (channelConfig.mode === "shim" && !hasIssueContext) {
        const ensured = await ensureTelegramIssueContext({
          context,
          routing,
          routingOverride,
          updateId: update.update_id,
          message,
          rawText,
          botToken,
          chatId: message.chat.id,
          threadId: contextThreadId ?? undefined,
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
          return ctx.text("", 200);
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
        return ctx.text("", 200);
      }

      await safeSendTelegramMessage({
        botToken,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: `Running /${commandName}.`,
        logger,
      });
      return ctx.text("", 200);
    }

    if (decision.action === "agent") {
      logger.info(
        {
          event: "telegram-agent",
          issueNumber: context.payload.issue.number,
        },
        "Starting Telegram agent planning mode"
      );
      const request = String(decision.task ?? "").trim() || rawText.trim();
      await startTelegramAgentPlanningSession({
        context,
        botToken,
        chat: message.chat,
        threadId: contextThreadId,
        userId: telegramUserId,
        replyToMessageId: message.message_id,
        request,
        conversationContext,
        hasIssueContext,
        routing,
        routingOverride,
        logger,
      });
      return ctx.text("", 200);
    }

    return ctx.text("", 200);
  } finally {
    stopTyping();
  }
}

function buildTelegramLinkingKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [[{ text: TELEGRAM_START_LINKING_LABEL, callback_data: TELEGRAM_LINK_START_CALLBACK_DATA }]],
  };
}

function buildTelegramIssueKeyboard(issueUrl: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [[{ text: "Open link issue", url: issueUrl }]],
  };
}

function buildTelegramLinkRecoveryKeyboard(owner: string): TelegramReplyMarkup {
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

function buildTelegramAgentPlanningKeyboard(params: { status: TelegramAgentPlanningSession["status"]; sessionId: string }): TelegramReplyMarkup {
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

function formatTelegramLinkError(message: string, owner?: string): string[] {
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

function parseGithubOwnerFromText(text: string): string | null {
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

async function safeAnswerTelegramCallbackQuery(params: { botToken: string; callbackQueryId: string; text?: string; logger: Logger }): Promise<void> {
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
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.warn({ status: response.status, detail }, "Failed to answer Telegram callback query");
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to answer Telegram callback query");
  }
}

async function safeEditTelegramMessageReplyMarkup(params: {
  botToken: string;
  chatId: number;
  messageId: number;
  replyMarkup?: TelegramReplyMarkup | null;
  logger: Logger;
}): Promise<void> {
  const { botToken, chatId, messageId, replyMarkup, logger } = params;
  const normalizedChatId = Math.trunc(chatId);
  const normalizedMessageId = Math.trunc(messageId);
  if (!Number.isFinite(normalizedChatId) || !Number.isFinite(normalizedMessageId) || normalizedMessageId <= 0) {
    return;
  }

  const markup = replyMarkup ?? { inline_keyboard: [] };
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: normalizedChatId,
        message_id: normalizedMessageId,
        reply_markup: markup,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.warn({ status: response.status, detail }, "Failed to edit Telegram message reply markup");
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to edit Telegram message reply markup");
  }
}

async function handleTelegramCallbackQuery(params: {
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

      const identityResult = await getTelegramLinkedIdentity({ userId, logger });
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

      const linkCodeResult = await getOrCreateTelegramLinkCode({ userId, logger });
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

      const identityResult = await getTelegramLinkedIdentity({ userId, logger });
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
        await safeSendTelegramMessage({
          botToken,
          chatId,
          replyToMessageId: callbackQuery.message?.message_id,
          text: `Already linked to ${identityResult.identity.owner}.`,
          logger,
        });
        return;
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
    replyMarkup: { inline_keyboard: [] },
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

  const channelConfigResult = parseTelegramChannelConfig(kernelConfigLoad.config, effectiveOwner);
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
    actorIdentity: identityResult.identity,
    githubConfig: githubConfigResult.config,
    aiConfig: aiConfigResult.config,
    agentConfig: agentConfigResult.config,
    kernelConfig: kernelConfigResult.config,
    kernelConfigOverride: undefined,
    fallbackOwner: effectiveOwner,
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

  await maybeHandleTelegramAgentPlanningSession({
    context: contextResult.context,
    botToken,
    chat: message.chat,
    threadId: contextThreadId,
    userId,
    replyToMessageId: message.message_id,
    rawText: "",
    conversationContext: "",
    routing,
    routingOverride,
    channelMode: channelConfig.mode,
    updateId: params.updateId,
    message: syntheticMessage,
    logger,
    hasIssueContext: contextResult.hasIssueContext,
    intent: params.action === "finalize" ? "finalize" : "approve",
  });
}

function getTelegramCallbackQuery(update: TelegramUpdate): TelegramCallbackQuery | null {
  return update.callback_query ?? null;
}

function getTelegramMyChatMemberUpdate(update: TelegramUpdate): TelegramChatMemberUpdated | null {
  return update.my_chat_member ?? null;
}

function getTelegramChatMemberUpdate(update: TelegramUpdate): TelegramChatMemberUpdated | null {
  return update.chat_member ?? null;
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

function resolveTelegramForumThreadId(params: { isForum?: boolean; messageThreadId?: number | null }): number | null {
  if (params.isForum && params.messageThreadId == null) {
    return TELEGRAM_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId ?? null;
}

/**
 * Thread params for `sendMessage`-style methods.
 * General forum topic (id=1) must be treated like a regular supergroup send:
 * Telegram rejects sendMessage with message_thread_id=1 ("thread not found").
 */
function buildTelegramThreadParams(messageThreadId?: number): { message_thread_id: number } | null {
  if (messageThreadId == null) return null;
  const normalized = Math.trunc(messageThreadId);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) return null;
  return { message_thread_id: normalized };
}

/**
 * Thread params for `sendChatAction` (typing indicators).
 * Empirically, General topic (id=1) can still use message_thread_id for typing to appear.
 */
function buildTypingThreadParams(messageThreadId?: number): { message_thread_id: number } | null {
  if (messageThreadId == null) return null;
  const normalized = Math.trunc(messageThreadId);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return { message_thread_id: normalized };
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

function parseTelegramSecretsConfig(env: Env):
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

function startTelegramChatActionLoop(params: {
  botToken: string;
  chatId: number;
  messageThreadId?: number;
  action: Parameters<typeof safeSendTelegramChatAction>[0]["action"];
  intervalMs?: number;
  logger: Logger;
}): () => void {
  const intervalMs =
    typeof params.intervalMs === "number" && Number.isFinite(params.intervalMs) ? Math.max(1000, Math.trunc(params.intervalMs)) : TELEGRAM_TYPING_INTERVAL_MS;

  // Fire immediately so the UI reacts fast, then keep it alive every few seconds.
  void safeSendTelegramChatAction(params);

  const interval = setInterval(() => {
    void safeSendTelegramChatAction(params);
  }, intervalMs);

  return () => clearInterval(interval);
}

async function safeSendTelegramMessage(params: {
  botToken: string;
  chatId: number;
  messageThreadId?: number;
  replyToMessageId?: number;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
  disableNotification?: boolean;
  shouldTruncate?: boolean;
  replyMarkup?: TelegramReplyMarkup;
  logger: Logger;
}): Promise<number | null> {
  const { botToken, chatId, messageThreadId, replyToMessageId, parseMode, disablePreview, disableNotification, shouldTruncate, replyMarkup, logger } = params;
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
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.warn({ status: response.status, detail }, "Failed to send Telegram reply");
      return null;
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
    } | null;
    return typeof data?.result?.message_id === "number" ? data.result.message_id : null;
  } catch (error) {
    logger.warn({ err: error }, "Failed to send Telegram reply");
    return null;
  }
}

async function safeSendTelegramMessageWithFallback(params: Parameters<typeof safeSendTelegramMessage>[0]): Promise<number | null> {
  const first = await safeSendTelegramMessage(params);
  if (first !== null || !params.replyToMessageId) {
    return first;
  }
  return safeSendTelegramMessage({ ...params, replyToMessageId: undefined });
}

async function safeSendTelegramChatAction(params: {
  botToken: string;
  chatId: number;
  messageThreadId?: number;
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

function tryBuildTelegramMessageLink(chat: TelegramChat, messageId: number): string | null {
  const normalizedMessageId = normalizePositiveInt(messageId);
  if (!normalizedMessageId) return null;

  const username = chat.username?.trim() ?? "";
  if (username) {
    // Public supergroup: message links use the username.
    return `https://t.me/${encodeURIComponent(username)}/${normalizedMessageId}`;
  }

  // Private supergroup: message links use /c/<internal chat id>/<message id>.
  const chatId = Math.trunc(chat.id);
  if (!Number.isFinite(chatId)) return null;
  const chatIdStr = String(chatId);
  if (!chatIdStr.startsWith("-100")) return null;
  const internalId = chatIdStr.slice("-100".length);
  if (!internalId || !/^[0-9]+$/.test(internalId)) return null;
  return `https://t.me/c/${internalId}/${normalizedMessageId}`;
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

function applyConversationGraphLimits(nodes: ParsedConversationNode[], maxNodes?: number, maxComments?: number): ParsedConversationNode[] {
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
  let isInComments = false;

  function flushComment(): void {
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
  }

  function flushNode(): void {
    if (!currentNode) return;
    flushComment();
    if (currentNode.comments.length > 1) {
      currentNode.comments.reverse();
    }
    nodes.push(currentNode);
    currentNode = null;
    isInComments = false;
  }

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
      isInComments = true;
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
      isInComments = false;
      continue;
    }

    if (!currentNode) {
      continue;
    }

    if (isInComments) {
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
      if (url && !url.rest && currentComment && !currentComment.url) {
        currentComment.url = url.url;
        continue;
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
  let isInCodeBlock = false;
  let codeFence = "```";
  let codeBuffer: string[] = [];

  function emitLine(rawLine: string): void {
    const trimmedRaw = rawLine.trimEnd();
    const trimmed = trimmedRaw.trim();
    if (isInCodeBlock) {
      if (trimmed.startsWith(codeFence)) {
        const codeText = codeBuffer.join("\n");
        lines.push(`<pre><code>${escapeTelegramHtml(codeText)}</code></pre>`);
        isInCodeBlock = false;
        codeBuffer = [];
        return;
      }
      codeBuffer.push(rawLine);
      return;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      isInCodeBlock = true;
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
  }

  for (const raw of rawLines) {
    emitLine(raw);
  }
  if (isInCodeBlock && codeBuffer.length > 0) {
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

const TELEGRAM_URL_PATTERN = "https?:\\/\\/[^\\s<>\"']+";

function splitUrls(raw: string): Array<{ kind: "text" | "url"; value: string }> {
  const regex = new RegExp(TELEGRAM_URL_PATTERN, "g");
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
  const match = new RegExp(`^(${TELEGRAM_URL_PATTERN})(?:\\s+(.*))?$`).exec(line.trim());
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

const COMMENT_LABEL = "Comment";
const REVIEW_LABEL = "Review";
const REVIEW_COMMENT_LABEL = "Review Comment";
const ISSUE_COMMENT_LABEL = "Issue Comment";

function parseCommentHeader(line: string): { label: string; author?: string } | null {
  const match = /^-\s*\[([^\]]+)\]\s*(.+)$/.exec(line);
  if (!match) return null;
  const label = normalizeConversationLabel(match[1]);
  if (label !== COMMENT_LABEL && label !== REVIEW_LABEL && label !== REVIEW_COMMENT_LABEL) return null;
  const meta = match[2] ?? "";
  const authorMatch = /@([^\s]+)/.exec(meta);
  const author = authorMatch?.[1];
  return { label, author };
}

function shouldSkipCommentBlock(meta: { label: string; author?: string } | null, blockLines: string[], filters: ConversationGraphFilters): boolean {
  const author = meta?.author;
  const shouldSkipBots = !filters.includeBots && typeof author === "string" && Boolean(author.trim()) && isBotAuthor(author);
  const shouldSkipCommands = Boolean(meta) && !filters.includeCommands && isCommandOnlyComment(blockLines);
  return shouldSkipBots || shouldSkipCommands;
}

function isBotAuthor(author: string): boolean {
  const normalized = author.trim().toLowerCase();
  return Boolean(normalized) && (normalized.includes("[bot]") || normalized.endsWith("-bot") || normalized.endsWith("_bot"));
}

function isCommandOnlyComment(blockLines: string[]): boolean {
  const bodyLines = extractCommentBodyLines(blockLines);
  return bodyLines.length === 0 || bodyLines.every((line) => /^\/[\w-]+(\s|$)/.test(line));
}

function extractCommentBodyLines(blockLines: string[]): string[] {
  const body: string[] = [];
  for (let i = 1; i < blockLines.length; i += 1) {
    const trimmed = blockLines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      continue;
    }
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
  if (trimmed === "Current thread" || trimmed === "Conversation links (auto-merged)" || trimmed === "Comments" || trimmed === "Similar (semantic)") {
    return trimmed;
  }
  return null;
}

function normalizeConversationLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed === ISSUE_COMMENT_LABEL) return COMMENT_LABEL;
  if (trimmed === REVIEW_COMMENT_LABEL) return REVIEW_COMMENT_LABEL;
  if (trimmed === REVIEW_LABEL) return REVIEW_LABEL;
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
      shouldTruncate: false,
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

async function safePinTelegramMessage(params: { botToken: string; chatId: number; messageId: number | null; logger: Logger }): Promise<void> {
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
  actorIdentity: TelegramLinkedIdentity | null;
  githubConfig: GitHubAppConfig;
  aiConfig: AiConfig;
  agentConfig: AgentConfig;
  kernelConfig: KernelConfig;
  kernelConfigOverride?: PluginConfiguration;
  fallbackOwner?: string;
  eventHandlerOverride?: GitHubEventHandler;
}): Promise<
  | {
      ok: true;
      context: GitHubContext<"issue_comment.created">;
      pluginsWithManifest: PluginWithManifest[];
      manifests: PluginWithManifest["manifest"][];
      hasIssueContext: boolean;
      pluginSummary: PluginCommandSummary;
      didUseFallbackConfig: boolean;
      fallbackOwner?: string;
      hasTargetConfig: boolean;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const {
    env,
    logger,
    updateId,
    message,
    rawText,
    kernelRefreshUrl,
    routing,
    actorIdentity,
    githubConfig,
    aiConfig,
    agentConfig,
    kernelConfig,
    kernelConfigOverride,
    eventHandlerOverride,
  } = params;
  const { owner, repo, issueNumber } = routing;
  if (!owner || !repo) {
    return { ok: false, error: "Missing Telegram routing configuration." };
  }
  const hasIssueContext = Number.isFinite(issueNumber) && Number(issueNumber) > 0;
  const normalizedIssueNumber = hasIssueContext ? Number(issueNumber) : 1;

  const eventHandler =
    eventHandlerOverride ??
    new GitHubEventHandler({
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
    return {
      ok: false,
      error: "No GitHub App installation found for Telegram routing.",
    };
  }

  const octokit = eventHandler.getAuthenticatedOctokit(installationId);
  const telegramAuthor = getTelegramAuthor(message);
  const linkedOwner = actorIdentity?.owner ? normalizeLogin(actorIdentity.owner) : "";
  const payloadAuthor = linkedOwner || telegramAuthor;
  const authorAssociation = linkedOwner && linkedOwner.toLowerCase() === owner.toLowerCase() ? "OWNER" : "NONE";
  const issueTitleFallback = message.chat.title?.trim() || message.chat.username?.trim() || `Telegram chat ${message.chat.id}`;
  let issuePayload: Record<string, unknown> = {
    number: normalizedIssueNumber,
    title: issueTitleFallback,
    body: "",
    labels: [],
    user: { login: owner },
  };
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
    }
  }
  const payload = {
    action: "created",
    installation: { id: installationId },
    repository: { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` },
    issue: issuePayload,
    comment: {
      id: Number.isFinite(updateId) ? updateId : 0,
      body: rawText,
      user: { login: payloadAuthor, type: "User" },
      author_association: authorAssociation,
    },
    sender: { login: payloadAuthor, type: "User" },
  };
  const event = {
    id: `telegram-${updateId}`,
    name: "issue_comment",
    payload,
  } as unknown as EmitterWebhookEvent;
  const context = new GitHubContext(eventHandler, event, octokit, logger);

  const targetConfig = kernelConfigOverride ?? (await getConfig(context));
  const configSources =
    (
      targetConfig as {
        __sources?: Array<{ owner: string; repo: string; path: string }>;
      }
    ).__sources ?? [];
  const hasTargetConfig = configSources.length > 0;
  let didUseFallbackConfig = false;
  const fallbackOwner = params.fallbackOwner?.trim();

  let kernelConfigFromRepo = targetConfig;
  if (!kernelConfigOverride && fallbackOwner && fallbackOwner.toLowerCase() !== owner.toLowerCase()) {
    const fallbackConfigResult = await getConfigurationFromRepo(context, CONFIG_ORG_REPO, fallbackOwner);
    if (fallbackConfigResult.config) {
      kernelConfigFromRepo = mergePluginConfigurations(fallbackConfigResult.config, targetConfig);
      didUseFallbackConfig = true;
    }
  }

  if (!kernelConfigFromRepo) {
    return {
      ok: false,
      error: "No kernel configuration was found for Telegram routing.",
    };
  }

  const { pluginsWithManifest, manifests, summary: pluginSummary } = await loadPluginsWithManifest(context, kernelConfigFromRepo.plugins);
  return {
    ok: true,
    context,
    pluginsWithManifest,
    manifests,
    hasIssueContext,
    pluginSummary,
    didUseFallbackConfig,
    ...(didUseFallbackConfig && fallbackOwner ? { fallbackOwner } : {}),
    hasTargetConfig,
  };
}

async function loadKernelConfigForOwner(params: {
  owner: string;
  env: Env;
  logger: Logger;
  githubConfig: GitHubAppConfig;
  aiConfig: AiConfig;
  agentConfig: AgentConfig;
  kernelConfig: KernelConfig;
  kernelRefreshUrl: string;
}): Promise<
  | {
      ok: true;
      config: PluginConfiguration;
      eventHandler: GitHubEventHandler;
      hasConfig: boolean;
    }
  | { ok: false; error: string }
> {
  const { owner, env, logger, githubConfig, aiConfig, agentConfig, kernelConfig, kernelRefreshUrl } = params;
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

  const installationId = await resolveInstallationId(eventHandler, owner, CONFIG_ORG_REPO, undefined, logger);
  if (!installationId) {
    return {
      ok: false,
      error: `No GitHub App installation found for ${owner}/${CONFIG_ORG_REPO}.`,
    };
  }

  const octokit = eventHandler.getAuthenticatedOctokit(installationId);
  const payload = {
    action: "created",
    installation: { id: installationId },
    repository: {
      owner: { login: owner },
      name: CONFIG_ORG_REPO,
      html_url: `https://github.com/${owner}/${CONFIG_ORG_REPO}`,
    },
    issue: {
      number: 1,
      title: "UbiquityOS config",
      body: "",
      labels: [],
      user: { login: owner },
    },
    comment: {
      id: 0,
      body: "",
      user: { login: owner, type: "User" },
      author_association: "OWNER",
    },
    sender: { login: owner, type: "User" },
  };
  const event = {
    id: `telegram-config-${owner}-${Date.now()}`,
    name: "issue_comment",
    payload,
  } as unknown as EmitterWebhookEvent;
  const context = new GitHubContext(eventHandler, event, octokit, logger);

  const { config } = await getConfigurationFromRepo(context, CONFIG_ORG_REPO, owner);
  if (!config) {
    logger.warn({ owner }, "No .ubiquity-os config found; falling back to shim defaults.");
    const fallbackConfig = Value.Create(configSchema) as PluginConfiguration;
    return { ok: true, config: fallbackConfig, eventHandler, hasConfig: false };
  }

  return { ok: true, config, eventHandler, hasConfig: true };
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
  threadId?: number;
  logger: Logger;
}): Promise<EnsureTelegramIssueContextResult> {
  const owner = params.routing.owner?.trim();
  const repo = params.routing.repo?.trim();
  if (!owner || !repo) {
    return {
      ok: false,
      error: "Missing repo context; set it with /topic <github-repo-url>.",
    };
  }

  const installationId = params.context.payload.installation?.id;
  if (!installationId) {
    return {
      ok: false,
      error: "No GitHub App installation found for Telegram routing.",
    };
  }

  try {
    const telegramAuthor = getTelegramAuthor(params.message);
    const payloadAuthor =
      typeof params.context.payload.comment?.user?.login === "string" && params.context.payload.comment.user.login.trim()
        ? params.context.payload.comment.user.login.trim()
        : telegramAuthor;
    const payloadAssociation =
      typeof params.context.payload.comment?.author_association === "string" && params.context.payload.comment.author_association.trim()
        ? params.context.payload.comment.author_association.trim()
        : "NONE";
    const chatLabel = formatTelegramChatLabel(params.message.chat);
    const title = buildTelegramSessionIssueTitle(telegramAuthor, chatLabel);
    const body = buildTelegramSessionIssueBody({
      author: telegramAuthor,
      chatLabel,
      chatId: params.message.chat.id,
      threadId: params.threadId,
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
      return {
        ok: false,
        error: "Failed to create a Telegram session comment.",
      };
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
      repository: { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` },
      issue: issuePayload,
      comment: {
        id: commentId,
        body: commentBody,
        user: { login: payloadAuthor, type: "User" },
        author_association: payloadAssociation,
      },
      sender: { login: payloadAuthor, type: "User" },
    };
    const event = {
      id: `telegram-${params.updateId}-${commentId}`,
      name: "issue_comment",
      payload,
    } as unknown as EmitterWebhookEvent;
    const context = new GitHubContext(params.context.eventHandler, event, params.context.octokit, params.logger);

    const issueUrl = issueResponse.data.html_url ?? buildIssueUrl({ owner, repo, issueNumber });
    params.logger.info({ event: "telegram-session", owner, repo, issueNumber }, "Created Telegram session issue");
    const override: TelegramRoutingOverride = {
      kind: "issue",
      owner,
      repo,
      issueNumber,
      installationId,
      sourceUrl: issueUrl,
    };
    let didPersist = false;
    const kv = await getTelegramKv(params.logger);
    if (kv) {
      didPersist = await saveTelegramRoutingOverride({
        botToken: params.botToken,
        chatId: params.chatId,
        threadId: params.threadId,
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
        persisted: didPersist,
      },
      routingOverride: override,
    };
  } catch (error) {
    params.logger.warn({ err: error, owner, repo }, "Failed to create Telegram session issue");
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message ? `Failed to create a Telegram session issue: ${message}` : "Failed to create a Telegram session issue.",
    };
  }
}

function buildTelegramIssueLink(issue: TelegramIssueCreation) {
  const label = `${issue.owner}/${issue.repo}#${issue.number}`;
  const link = `<a href="${escapeTelegramHtmlAttribute(issue.url)}">${escapeTelegramHtml(label)}</a>`;
  const suffix = issue.persisted ? "" : " Context wasn't saved; use /topic to pin it.";
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
    params.logger.debug(
      {
        err: error,
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issueNumber,
      },
      "Failed to hydrate Telegram issue payload"
    );
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
      text: "Command renamed: use /_ping.",
      logger: params.logger,
    });
    return true;
  }
  if (command === "_ping") {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "pong",
      logger: params.logger,
    });
    return true;
  }
  return false;
}

function formatTelegramStatusTimestamp(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : String(value);
  }
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

async function handleTelegramStatusCommand(params: {
  botToken: string;
  chatId: number;
  replyToMessageId: number;
  userId: number;
  identity: TelegramLinkedIdentity | null;
  isPrivate: boolean;
  logger: Logger;
}): Promise<boolean> {
  const lines: string[] = [];
  let replyMarkup: TelegramReplyMarkup | undefined;

  if (params.identity) {
    lines.push("Status: linked");
    lines.push(`GitHub owner: ${params.identity.owner}`);
    // No timestamp or config path in status per UX guidance.
  } else {
    const pendingResult = await getTelegramLinkPending({
      userId: params.userId,
      logger: params.logger,
    });
    if (!pendingResult.ok) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chatId,
        replyToMessageId: params.replyToMessageId,
        text: pendingResult.error,
        logger: params.logger,
      });
      return true;
    }

    let pending = pendingResult.pending;
    if (pending && pending.expiresAtMs <= Date.now()) {
      await clearTelegramLinkPending({
        userId: params.userId,
        logger: params.logger,
      });
      pending = null;
    }

    if (pending) {
      lines.push("Status: linking");
      if (pending.owner) {
        lines.push(`Owner: ${pending.owner}`);
      }
      if (pending.step === "awaiting_owner") {
        lines.push("Step: waiting for GitHub owner");
        lines.push("Send the GitHub owner (username or org) to continue.");
      } else {
        lines.push("Step: waiting for link issue close");
        const issueResult = await getTelegramLinkIssue({
          code: pending.code,
          logger: params.logger,
        });
        if (issueResult.ok && issueResult.issue?.issueUrl) {
          lines.push(`Issue: ${issueResult.issue.issueUrl}`);
          replyMarkup = buildTelegramIssueKeyboard(issueResult.issue.issueUrl);
        }
        lines.push("Close the issue to approve linking.");
      }
      lines.push(`Expires: ${formatTelegramStatusTimestamp(pending.expiresAtMs)}`);
    } else {
      lines.push("Status: not linked");
      if (!params.isPrivate) {
        lines.push("Linking is only available in a direct message.");
      } else {
        lines.push(`Tap ${TELEGRAM_START_LINKING_LABEL} to begin.`);
        replyMarkup = buildTelegramLinkingKeyboard();
      }
    }
  }

  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chatId,
    replyToMessageId: params.replyToMessageId,
    text: lines.join("\n"),
    ...(replyMarkup ? { replyMarkup } : {}),
    logger: params.logger,
  });
  return true;
}

async function safeIsTelegramChatAdmin(params: { botToken: string; chatId: number; userId: number; logger: Logger }): Promise<boolean | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/getChatMember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        user_id: params.userId,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const description = tryParseTelegramErrorDescription(detail);
      params.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          status: response.status,
          detail,
          ...(description ? { description } : {}),
        },
        "Failed to verify Telegram admin status"
      );
      return null;
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { status?: string };
    } | null;
    const status = data?.result?.status ?? "";
    return status === "creator" || status === "administrator";
  } catch (error) {
    params.logger.warn({ chatId: params.chatId, userId: params.userId, err: error }, "Failed to verify Telegram admin status");
    return null;
  }
}

function tryParseTelegramErrorDescription(detail: string): string | null {
  const trimmed = detail.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { description?: unknown } | null;
    const description = parsed?.description;
    if (typeof description !== "string") return null;
    const normalized = description.trim();
    return normalized ? normalized : null;
  } catch {
    return null;
  }
}

function isTelegramChatUnavailableError(description?: string): boolean {
  const normalized = (description ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("chat not found") ||
    normalized.includes("bot was kicked") ||
    normalized.includes("bot is not a member") ||
    normalized.includes("group chat was upgraded to a supergroup chat")
  );
}

async function safeCreateTelegramChatInviteLink(params: {
  botToken: string;
  chatId: number;
  expireInSeconds: number;
  memberLimit: number;
  name?: string;
  logger: Logger;
}): Promise<
  | { ok: true; inviteLink: string }
  | {
      ok: false;
      error: string;
      status?: number;
      description?: string;
    }
> {
  const expireInSeconds = Math.trunc(params.expireInSeconds);
  const memberLimit = Math.trunc(params.memberLimit);
  if (!Number.isFinite(expireInSeconds) || expireInSeconds <= 0) {
    return { ok: false, error: "Invalid invite link expiration." };
  }
  if (!Number.isFinite(memberLimit) || memberLimit <= 0) {
    return { ok: false, error: "Invalid invite link limit." };
  }

  const expireDate = Math.trunc(Date.now() / 1000) + expireInSeconds;

  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/createChatInviteLink`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        ...(params.name?.trim() ? { name: params.name.trim() } : {}),
        expire_date: expireDate,
        member_limit: memberLimit,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const description = tryParseTelegramErrorDescription(detail);
      params.logger.warn(
        {
          chatId: params.chatId,
          status: response.status,
          detail,
          ...(description ? { description } : {}),
        },
        "Failed to create Telegram invite link"
      );
      return {
        ok: false,
        status: response.status,
        ...(description ? { description } : {}),
        error: "Couldn't create an invite link. Ensure the bot can invite users in the group.",
      };
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { invite_link?: unknown };
    } | null;
    const inviteLink = data?.result?.invite_link;
    if (typeof inviteLink !== "string" || !inviteLink.trim()) {
      return { ok: false, error: "Couldn't create an invite link." };
    }
    return { ok: true, inviteLink: inviteLink.trim() };
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to create Telegram invite link");
    return { ok: false, error: "Couldn't create an invite link." };
  }
}

async function safeSetTelegramChatPhoto(params: {
  botToken: string;
  chatId: number;
  photoFileId: string;
  logger: Logger;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const photoFileId = params.photoFileId.trim();
  if (!photoFileId) return { ok: false, error: "Missing photo file id." };

  try {
    // When `photo` is a Telegram file_id, this endpoint accepts JSON (no multipart upload needed).
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/setChatPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        photo: photoFileId,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const description = tryParseTelegramErrorDescription(detail);
      params.logger.warn(
        {
          chatId: params.chatId,
          status: response.status,
          ...(description ? { description } : {}),
          detail,
        },
        "Failed to set Telegram chat photo"
      );
      return { ok: false, error: "Couldn't set the workspace photo." };
    }
    return { ok: true };
  } catch (error) {
    params.logger.warn({ err: error, chatId: params.chatId }, "Failed to set Telegram chat photo");
    return { ok: false, error: "Couldn't set the workspace photo." };
  }
}

async function safePromoteTelegramChatMember(params: {
  botToken: string;
  chatId: number;
  userId: number;
  logger: Logger;
}): Promise<{ ok: true; attempt: "full" | "limited" | "minimal" } | { ok: false; error: string }> {
  const describeBotPermissionsForPromotionFailure = async (): Promise<void> => {
    const botUserId = parseOptionalPositiveInt(getTelegramBotId(params.botToken));
    if (!botUserId) return;

    const snapshot = await safeFetchTelegramChatMemberSnapshot({
      botToken: params.botToken,
      chatId: params.chatId,
      userId: botUserId,
    });

    if (snapshot.ok) {
      params.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          botUserId,
          botStatus: snapshot.snapshot.status,
          botCanPromoteMembers: snapshot.snapshot.can_promote_members,
          botMember: snapshot.snapshot,
        },
        "Telegram bot admin rights snapshot (promotion failed)"
      );
      return;
    }

    params.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        botUserId,
        status: snapshot.status,
        ...(snapshot.description ? { description: snapshot.description } : {}),
        ...(snapshot.detail ? { detail: snapshot.detail } : {}),
      },
      "Failed to inspect Telegram bot admin rights (promotion failed)"
    );
  };

  try {
    const url = `https://api.telegram.org/bot${params.botToken}/promoteChatMember`;

    const payloads: Array<{
      label: "full" | "limited" | "minimal";
      body: Record<string, unknown>;
    }> = [
      {
        label: "full",
        body: {
          chat_id: params.chatId,
          user_id: params.userId,
          can_manage_topics: true,
          can_invite_users: true,
          can_pin_messages: true,
          can_change_info: true,
          can_manage_chat: true,
          can_delete_messages: true,
          can_restrict_members: true,
          can_promote_members: true,
          can_manage_video_chats: true,
          is_anonymous: false,
        },
      },
      {
        label: "limited",
        body: {
          chat_id: params.chatId,
          user_id: params.userId,
          can_manage_topics: true,
          can_invite_users: true,
          can_pin_messages: true,
          can_change_info: true,
          can_delete_messages: true,
          is_anonymous: false,
        },
      },
      {
        label: "minimal",
        body: {
          chat_id: params.chatId,
          user_id: params.userId,
          can_manage_topics: true,
          can_invite_users: true,
          can_pin_messages: true,
          can_change_info: true,
          is_anonymous: false,
        },
      },
    ];

    let lastStatus: number | undefined;
    let lastDetail = "";
    let lastDescription: string | null = null;

    for (const payload of payloads) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.body),
      });

      if (response.ok) {
        return { ok: true, attempt: payload.label };
      }

      lastStatus = response.status;
      lastDetail = await response.text().catch(() => "");
      lastDescription = tryParseTelegramErrorDescription(lastDetail);

      params.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          status: response.status,
          detail: lastDetail,
          ...(lastDescription ? { description: lastDescription } : {}),
          attempt: payload.label,
        },
        "Failed to promote Telegram chat member"
      );

      const normalizedDescription = (lastDescription ?? "").toLowerCase();
      const isRightsError =
        normalizedDescription.includes("right_forbidden") ||
        normalizedDescription.includes(TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION) ||
        normalizedDescription.includes("chat_admin_required");
      const shouldRetry = isRightsError && payload.label !== "minimal";
      if (!shouldRetry) {
        break;
      }
    }

    await describeBotPermissionsForPromotionFailure();

    if (lastDescription) {
      const normalized = lastDescription.toLowerCase();
      if (normalized.includes("bot is not a member")) {
        return {
          ok: false,
          error: "Couldn't promote you to admin because the bot isn't a member of this group.",
        };
      }
      if (
        normalized.includes("right_forbidden") ||
        normalized.includes(TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION) ||
        normalized.includes("chat_admin_required")
      ) {
        return {
          ok: false,
          error:
            "Couldn't promote you to admin because the bot doesn't have permission to add administrators in this group. Promote the bot to admin and enable the “Add Admins” permission.",
        };
      }
      return { ok: false, error: `Couldn't promote you to admin: ${lastDescription}` };
    }

    return {
      ok: false,
      error: lastStatus ? `Couldn't promote you to admin (status ${lastStatus}).` : "Couldn't promote you to admin.",
    };
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to promote Telegram chat member");
    await describeBotPermissionsForPromotionFailure();
    return { ok: false, error: "Couldn't promote you to admin." };
  }
}

type TelegramChatMemberSnapshot = {
  status?: string;
  can_manage_chat?: boolean;
  can_manage_topics?: boolean;
  can_invite_users?: boolean;
  can_pin_messages?: boolean;
  can_change_info?: boolean;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
  can_promote_members?: boolean;
  can_manage_video_chats?: boolean;
  is_anonymous?: boolean;
};

async function safeFetchTelegramChatMemberSnapshot(params: {
  botToken: string;
  chatId: number;
  userId: number;
}): Promise<{ ok: true; snapshot: TelegramChatMemberSnapshot } | { ok: false; status?: number; description?: string; detail?: string }> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/getChatMember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        user_id: params.userId,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const description = tryParseTelegramErrorDescription(detail);
      return {
        ok: false,
        status: response.status,
        ...(description ? { description } : {}),
        ...(detail ? { detail } : {}),
      };
    }

    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
    } | null;
    const result = data?.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return { ok: false, detail: "Missing chat member result payload." };
    }

    const record = result as Record<string, unknown>;
    const snapshot: TelegramChatMemberSnapshot = {};
    const status = record.status;
    if (typeof status === "string" && status.trim()) {
      snapshot.status = status.trim();
    }
    for (const key of [
      "can_manage_chat",
      "can_manage_topics",
      "can_invite_users",
      "can_pin_messages",
      "can_change_info",
      "can_delete_messages",
      "can_restrict_members",
      "can_promote_members",
      "can_manage_video_chats",
      "is_anonymous",
    ] as const) {
      const value = record[key];
      if (typeof value === "boolean") {
        snapshot[key] = value;
      }
    }

    return { ok: true, snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Failed to fetch chat member: ${message}` };
  }
}

async function safeGetTelegramChatMemberCount(params: { botToken: string; chatId: number; logger: Logger }): Promise<number | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/getChatMemberCount`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: params.chatId }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.warn({ status: response.status, detail }, "Failed to fetch Telegram chat member count");
      return null;
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
    } | null;
    const count = data?.result;
    if (typeof count !== "number" || !Number.isFinite(count)) return null;
    const normalized = Math.trunc(count);
    return normalized >= 0 ? normalized : null;
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to fetch Telegram chat member count");
    return null;
  }
}

async function safeLeaveTelegramChat(params: { botToken: string; chatId: number; logger: Logger }): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/leaveChat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: params.chatId }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.warn({ status: response.status, detail }, "Failed to leave Telegram chat");
    }
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to leave Telegram chat");
  }
}

async function handleTelegramMyChatMemberUpdate(params: { botToken: string; update: TelegramChatMemberUpdated; logger: Logger }): Promise<void> {
  const chatId = typeof params.update.chat?.id === "number" ? params.update.chat.id : null;
  if (!chatId || !Number.isFinite(chatId)) return;

  const newStatus = params.update.new_chat_member?.status?.trim().toLowerCase() ?? "";
  if (newStatus !== "kicked" && newStatus !== "left") return;

  // my_chat_member updates should always refer to the current bot, but verify best-effort when possible.
  const botIdStr = getTelegramBotId(params.botToken);
  const botId = Number.parseInt(botIdStr, 10);
  const updateBotId = params.update.new_chat_member?.user?.id;
  if (Number.isFinite(botId) && typeof updateBotId === "number" && updateBotId !== botId) {
    return;
  }

  const kv = await getTelegramKv(params.logger);
  if (!kv) return;

  // Best-effort cleanup: remove any workspace bootstrap / claim mappings tied to this chat.
  const botTokenId = botIdStr || "unknown";
  const pending = await loadTelegramWorkspaceBootstrapByChat({
    kv,
    botId: botTokenId,
    chatId,
    logger: params.logger,
  });
  if (pending) {
    await deleteTelegramWorkspaceBootstrap({
      kv,
      botId: botTokenId,
      userId: pending.userId,
      chatId,
      logger: params.logger,
    });
  }

  const workspace = await loadTelegramWorkspaceByChat({
    kv,
    botId: botTokenId,
    chatId,
    logger: params.logger,
  });
  if (workspace) {
    const unclaimed = await unclaimTelegramWorkspace({
      kv,
      botId: botTokenId,
      userId: workspace.userId,
      logger: params.logger,
    });
    if (!unclaimed.ok) {
      params.logger.warn({ chatId, userId: workspace.userId, error: unclaimed.error }, "Failed to unclaim Telegram workspace after bot removal");
    }
  }

  await deleteTelegramRoutingOverridesForChat({
    kv,
    botId: botTokenId,
    chatId,
    logger: params.logger,
  });
}

async function handleTelegramChatMemberUpdate(params: { botToken: string; update: TelegramChatMemberUpdated; logger: Logger }): Promise<void> {
  const chatId = typeof params.update.chat?.id === "number" ? params.update.chat.id : null;
  if (!chatId || !Number.isFinite(chatId)) return;

  const userId = typeof params.update.new_chat_member?.user?.id === "number" ? params.update.new_chat_member.user.id : null;
  if (!userId || !Number.isFinite(userId)) return;

  const oldStatus = params.update.old_chat_member?.status?.trim().toLowerCase() ?? "";
  const newStatus = params.update.new_chat_member?.status?.trim().toLowerCase() ?? "";

  if (newStatus === "kicked" || newStatus === "left") {
    params.logger.info({ chatId, userId, oldStatus, newStatus, event: "telegram-chat-member" }, "Telegram chat member update");
    await maybeHandleTelegramWorkspaceOwnerLeft({
      botToken: params.botToken,
      chatId,
      userId,
      logger: params.logger,
    });
    return;
  }

  // `chat_member` updates are the most reliable signal for join/leave events. Use them to
  // finalize DM-bootstrapped workspaces even when "join messages" are disabled in the group.
  if ((newStatus === "member" || newStatus === "administrator" || newStatus === "creator") && newStatus !== oldStatus) {
    params.logger.info({ chatId, userId, oldStatus, newStatus, event: "telegram-chat-member" }, "Telegram chat member update");
    await maybeFinalizeTelegramWorkspaceBootstrap({
      botToken: params.botToken,
      chatId,
      userId,
      logger: params.logger,
      source: "chat_member",
    });
  }
}

async function maybeHandleTelegramWorkspaceOwnerLeft(params: { botToken: string; chatId: number; userId: number; logger: Logger }): Promise<void> {
  const kv = await getTelegramKv(params.logger);
  if (!kv) return;

  const botId = getTelegramBotId(params.botToken);
  const workspace = await loadTelegramWorkspaceByChat({
    kv,
    botId,
    chatId: params.chatId,
    logger: params.logger,
  });
  if (!workspace) return;
  if (workspace.userId !== params.userId) return;

  const unclaimed = await unclaimTelegramWorkspace({
    kv,
    botId,
    userId: params.userId,
    logger: params.logger,
  });
  if (!unclaimed.ok) {
    params.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        error: unclaimed.error,
      },
      "Failed to unclaim Telegram workspace after member left"
    );
    return;
  }

  const memberCount = await safeGetTelegramChatMemberCount({
    botToken: params.botToken,
    chatId: params.chatId,
    logger: params.logger,
  });
  if (memberCount !== null && memberCount <= 1) {
    await safeLeaveTelegramChat({
      botToken: params.botToken,
      chatId: params.chatId,
      logger: params.logger,
    });
  }
}

async function maybeFinalizeTelegramWorkspaceBootstrap(params: {
  botToken: string;
  chatId: number;
  userId: number;
  logger: Logger;
  source: "chat_member" | "message.new_chat_members" | "message.sender";
}): Promise<void> {
  const kv = await getTelegramKv(params.logger);
  if (!kv) return;

  const botId = getTelegramBotId(params.botToken);
  const pending = await loadTelegramWorkspaceBootstrapByChat({
    kv,
    botId,
    chatId: params.chatId,
    logger: params.logger,
  });
  if (!pending) return;
  if (pending.userId !== params.userId) return;

  params.logger.info({ chatId: params.chatId, userId: params.userId, source: params.source }, "Workspace bootstrap: finalizing");

  const claim = await claimTelegramWorkspace({
    kv,
    botId,
    userId: params.userId,
    chatId: params.chatId,
    logger: params.logger,
  });
  if (!claim.ok) {
    params.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        error: claim.error,
      },
      "Workspace bootstrap claim failed"
    );
    return;
  }

  params.logger.info(
    {
      chatId: params.chatId,
      userId: params.userId,
      changed: claim.changed,
      claimedAt: claim.record.claimedAt,
    },
    "Workspace bootstrap: claimed"
  );

  const isAdmin = await safeIsTelegramChatAdmin({
    botToken: params.botToken,
    chatId: params.chatId,
    userId: params.userId,
    logger: params.logger,
  });

  params.logger.info({ chatId: params.chatId, userId: params.userId, isAdmin }, "Workspace bootstrap: admin status");

  if (isAdmin === false) {
    const promoteResult = await safePromoteTelegramChatMember({
      botToken: params.botToken,
      chatId: params.chatId,
      userId: params.userId,
      logger: params.logger,
    });
    if (!promoteResult.ok) {
      params.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          error: promoteResult.error,
        },
        "Workspace bootstrap promotion failed"
      );
      // Keep the pending record so the user can retry after permissions are fixed.
      return;
    }
    params.logger.info({ chatId: params.chatId, userId: params.userId, attempt: promoteResult.attempt }, "Workspace bootstrap: promoted");
    const isAdminAfter = await safeIsTelegramChatAdmin({
      botToken: params.botToken,
      chatId: params.chatId,
      userId: params.userId,
      logger: params.logger,
    });
    if (isAdminAfter !== true) {
      return;
    }
  } else if (isAdmin === null) {
    // If we can't verify, keep the pending record to retry later.
    params.logger.warn({ chatId: params.chatId, userId: params.userId }, "Workspace bootstrap: couldn't verify admin status; will retry later");
    return;
  }

  await deleteTelegramWorkspaceBootstrap({
    kv,
    botId,
    userId: params.userId,
    chatId: params.chatId,
    logger: params.logger,
  });
  params.logger.info({ chatId: params.chatId, userId: params.userId }, "Workspace bootstrap: completed");
}

async function handleTelegramWorkspaceBootstrapCommand(params: {
  botToken: string;
  chat: TelegramChat;
  userId: number;
  replyToMessageId: number;
  allowWorkspace: boolean;
  secrets: TelegramSecretsConfig;
  owner: string;
  logger: Logger;
}): Promise<boolean> {
  if (!params.allowWorkspace) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Workspace topics are only available in shim mode.",
      logger: params.logger,
    });
    return true;
  }

  if (params.chat.type !== "private") {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Run /workspace in a direct message with the bot.",
      logger: params.logger,
    });
    return true;
  }

  const apiId = params.secrets.apiId;
  const apiHash = params.secrets.apiHash?.trim() ?? "";
  const userSession = params.secrets.userSession?.trim() ?? "";
  if (!apiId || !apiHash || !userSession) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Workspace bootstrap isn't configured. For local dev, run: deno task telegram:user:login:write",
      logger: params.logger,
    });
    return true;
  }

  const kv = await getTelegramKv(params.logger);
  if (!kv) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "KV is unavailable, so I can't bootstrap a workspace right now.",
      logger: params.logger,
    });
    return true;
  }

  const botId = getTelegramBotId(params.botToken);
  const existingWorkspace = await loadTelegramWorkspaceByUser({
    kv,
    botId,
    userId: params.userId,
    logger: params.logger,
  });
  if (existingWorkspace) {
    const invite = await safeCreateTelegramChatInviteLink({
      botToken: params.botToken,
      chatId: existingWorkspace.chatId,
      expireInSeconds: 60 * 60,
      memberLimit: 1,
      name: "workspace access",
      logger: params.logger,
    });

    if (invite.ok) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: [
          "You already have a workspace group.",
          "",
          "Open/join link (expires in 1 hour, single-use):",
          invite.inviteLink,
          "",
          "To create a new one, delete/leave the group and run /workspace again.",
        ].join("\n"),
        logger: params.logger,
      });
      return true;
    }

    // If the bot can't access the old chat (deleted / kicked), clear the stale mapping and proceed.
    if (isTelegramChatUnavailableError(invite.description)) {
      const pending = await loadTelegramWorkspaceBootstrapByChat({
        kv,
        botId,
        chatId: existingWorkspace.chatId,
        logger: params.logger,
      });
      if (pending) {
        await deleteTelegramWorkspaceBootstrap({
          kv,
          botId,
          userId: pending.userId,
          chatId: existingWorkspace.chatId,
          logger: params.logger,
        });
      }
      await deleteTelegramRoutingOverridesForChat({
        kv,
        botId,
        chatId: existingWorkspace.chatId,
        logger: params.logger,
      });

      const unclaimed = await unclaimTelegramWorkspace({
        kv,
        botId,
        userId: params.userId,
        logger: params.logger,
      });
      if (!unclaimed.ok) {
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: `I couldn't clear your previous workspace mapping. Please try again.\n\n${unclaimed.error}`,
          logger: params.logger,
        });
        return true;
      }
      // fallthrough: create a new workspace
    } else {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: [
          "You already have a workspace group, but I couldn't create a join link for it.",
          "",
          invite.error,
          "",
          "To create a new one, delete/leave the group and run /workspace again.",
        ].join("\n"),
        logger: params.logger,
      });
      return true;
    }
  }

  const pending = await loadTelegramWorkspaceBootstrapByUser({
    kv,
    botId,
    userId: params.userId,
    logger: params.logger,
  });
  if (pending?.inviteLink) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: `You already have a pending workspace invite:\n${pending.inviteLink}`,
      logger: params.logger,
    });
    return true;
  }

  const ownerLabel = normalizeLogin(params.owner);
  const titleSuffix = ownerLabel ? ` (${ownerLabel})` : "";
  const title = clampTelegramTopicName(`UbiquityOS Workspace${titleSuffix}`);
  const about = "UbiquityOS workspace group.";

  const created = await createTelegramWorkspaceForumSupergroup({
    mtproto: { apiId, apiHash, userSession },
    botToken: params.botToken,
    title,
    about,
    logger: params.logger,
  });
  if (!created.ok) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: created.error,
      logger: params.logger,
    });
    return true;
  }

  const workspacePhotoFileId = params.secrets.workspacePhotoFileId?.trim() ?? "";
  if (workspacePhotoFileId) {
    const photo = await safeSetTelegramChatPhoto({
      botToken: params.botToken,
      chatId: created.chatId,
      photoFileId: workspacePhotoFileId,
      logger: params.logger,
    });
    if (!photo.ok) {
      // Non-fatal: the invite link + bootstrap can proceed even if the avatar fails.
      params.logger.warn({ chatId: created.chatId, error: photo.error }, "Workspace bootstrap: failed to set workspace photo");
    }
  }

  const invite = await safeCreateTelegramChatInviteLink({
    botToken: params.botToken,
    chatId: created.chatId,
    expireInSeconds: 60 * 60,
    memberLimit: 1,
    name: "workspace bootstrap",
    logger: params.logger,
  });
  if (!invite.ok) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: invite.error,
      logger: params.logger,
    });
    return true;
  }

  const saved = await saveTelegramWorkspaceBootstrap({
    kv,
    botId,
    userId: params.userId,
    chatId: created.chatId,
    inviteLink: invite.inviteLink,
    ttlMs: 60 * 60 * 1000,
    logger: params.logger,
  });
  if (!saved.ok) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: saved.error,
      logger: params.logger,
    });
    return true;
  }

  params.logger.info(
    {
      chatId: created.chatId,
      userId: params.userId,
      event: "telegram-workspace-bootstrap",
      phase: "pending_saved",
    },
    "Workspace bootstrap: pending activation saved"
  );

  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    replyToMessageId: params.replyToMessageId,
    text: [
      `Workspace created: ${created.title}`,
      "",
      "Join link (expires in 1 hour, single-use):",
      invite.inviteLink,
      "",
      "Once you join, I'll activate the workspace (and promote you to admin). If that doesn't happen, send /help in the group to retry.",
    ].join("\n"),
    logger: params.logger,
  });

  return true;
}

function clampTelegramTopicName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "UbiquityOS topic";
  if (trimmed.length <= TELEGRAM_FORUM_TOPIC_NAME_MAX_CHARS) return trimmed;
  const suffix = "...";
  return trimmed.slice(0, TELEGRAM_FORUM_TOPIC_NAME_MAX_CHARS - suffix.length) + suffix;
}

async function safeCreateTelegramForumTopic(params: {
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

async function handleTelegramTopicCommand(params: {
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
              url: buildIssueUrl({
                owner,
                repo,
                issueNumber: Math.trunc(issueNumber),
              }),
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
    return `Context set to org ${override.owner} (config: ${override.owner}/${CONFIG_ORG_REPO}). Send a message to start a session, or use /topic <issue-url> to pin to a specific issue.`;
  }
  return `Context set to ${override.owner}/${override.repo}. Send a message to start a session, or use /topic <issue-url> to pin to a specific issue.`;
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
  if (!kv && !hasTelegramKvWarningIssued) {
    logger.warn({ feature: "telegram-context" }, "KV unavailable; Telegram context will not persist.");
    hasTelegramKvWarningIssued = true;
  }
  return kv;
}

async function loadTelegramRoutingOverride(params: {
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

async function saveTelegramRoutingOverride(params: {
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

async function deleteTelegramRoutingOverridesForChat(params: { kv: KvLike; botId: string; chatId: number; logger: Logger }): Promise<void> {
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
  let kind: TelegramContextKind;
  if (kindRaw === "org" || kindRaw === "repo" || kindRaw === "issue") {
    kind = kindRaw as TelegramContextKind;
  } else if (issueNumber) {
    kind = "issue";
  } else {
    kind = "repo";
  }
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
    const { data } = await appOctokit.rest.apps.getRepoInstallation({
      owner,
      repo,
    });
    if (typeof data?.id === "number") return data.id;
  } catch (error) {
    logger.warn({ err: error, owner, repo }, "Failed to resolve GitHub App installation for Telegram routing");
  }
  return null;
}

async function loadPluginsWithManifest(
  context: GitHubContext<"issue_comment.created">,
  plugins: Record<string, Record<string, unknown> | null | undefined>
): Promise<{
  pluginsWithManifest: PluginWithManifest[];
  manifests: PluginWithManifest["manifest"][];
  summary: PluginCommandSummary;
}> {
  const isBotAuthor = context.payload.comment.user?.type !== "User";
  const pluginsWithManifest: PluginWithManifest[] = [];
  const manifests: PluginWithManifest["manifest"][] = [];
  const summary: PluginCommandSummary = {
    total: Object.keys(plugins).length,
    withCommands: 0,
    missingManifest: 0,
    noCommands: 0,
    invalid: 0,
    skippedBotEvents: 0,
  };

  for (const [pluginKey, pluginSettings] of Object.entries(plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      summary.invalid += 1;
      continue;
    }
    if (isBotAuthor && (pluginSettings as { skipBotEvents?: boolean })?.skipBotEvents) {
      summary.skippedBotEvents += 1;
      continue;
    }
    const manifest = await getManifest(context, target);
    if (!manifest) {
      summary.missingManifest += 1;
      continue;
    }
    const commandEntries = manifest.commands ? Object.keys(manifest.commands) : [];
    if (!commandEntries.length) {
      summary.noCommands += 1;
      continue;
    }
    summary.withCommands += 1;
    const entry = { target, settings: pluginSettings, manifest };
    pluginsWithManifest.push(entry);
    manifests.push(manifest);
  }
  return { pluginsWithManifest, manifests, summary };
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
    commands: Array<{
      name: string;
      description: string;
      example: string;
      parameters: unknown;
    }>;
    conversationContext: string;
    agentPlanningSession?: TelegramAgentPlanningSession | null;
    onError: (message: string) => Promise<void>;
  }>
): Promise<RouterDecision | null> {
  const prompt = buildRouterPrompt({
    commands: params.commands,
    recentCommentsDescription: "array of recent Telegram messages: { id, author, body }",
    replyActionDescription: "send a Telegram message",
    agentPlanningAvailable: true,
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
    ...(params.agentPlanningSession
      ? {
          agentPlanningSession: {
            status: params.agentPlanningSession.status,
            request: clampText(params.agentPlanningSession.request, 2000),
            title: params.agentPlanningSession.draft?.title ?? "",
            questions: params.agentPlanningSession.draft?.questions ?? [],
            plan: params.agentPlanningSession.draft?.plan ?? [],
          },
        }
      : {}),
  };

  try {
    const raw = await callUbqAiRouter(context, prompt, routerInput);
    const decision = tryParseRouterDecision(raw);
    const action = decision?.action ?? "parse-error";
    const commandName = decision?.action === "command" ? decision.command?.name : undefined;
    const operation = decision?.action === "agent_plan" ? decision.operation : undefined;
    context.logger.info({ event: "telegram-router", command: commandName, operation }, `Telegram router decision: ${action}`);
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

type TelegramAgentPlanningKeyword = "approve" | "cancel" | "finalize";

function parseTelegramAgentPlanningKeyword(rawText: string): TelegramAgentPlanningKeyword | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  const withoutMention = trimmed.replace(/^@ubiquityos\b\s*/i, "");
  const normalized = withoutMention.toLowerCase();

  if (normalized === "approve" || normalized === "/approve") {
    return "approve";
  }

  if (normalized === "finalize" || normalized === "/finalize") {
    return "finalize";
  }

  if (normalized === "cancel" || normalized === "/cancel" || normalized === "abort" || normalized === "/abort") {
    return "cancel";
  }
  return null;
}

function clampAgentTask(value: string, maxChars = TELEGRAM_AGENT_TASK_MAX_CHARS): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatTelegramAgentPlanningMessage(params: {
  status: TelegramAgentPlanningSession["status"];
  title: string;
  questions: string[];
  plan: string[];
  targetLabel: string | null;
  ttlMs: number;
}): string {
  const ttlMinutes = Math.max(1, Math.round(params.ttlMs / 60_000));
  const header = params.status === "awaiting_approval" ? "Plan ready." : "Planning mode.";
  const lines: string[] = [header];
  if (params.targetLabel) {
    lines.push(`Target: ${params.targetLabel}`);
  }
  if (params.title.trim()) {
    lines.push(`Title: ${params.title.trim()}`);
  }

  if (params.questions.length) {
    lines.push("");
    lines.push("Questions:");
    for (let i = 0; i < params.questions.length; i += 1) {
      lines.push(`${i + 1}) ${params.questions[i]}`);
    }
  }

  if (params.plan.length) {
    lines.push("");
    lines.push(params.status === "awaiting_approval" ? "Plan:" : "Draft plan:");
    for (let i = 0; i < params.plan.length; i += 1) {
      lines.push(`${i + 1}) ${params.plan[i]}`);
    }
  }

  lines.push("");
  if (params.status === "awaiting_approval") {
    lines.push("Tap Approve to start the agent run, or Cancel to abort.");
    lines.push("(You can also type APPROVE/CANCEL.)");
  } else {
    lines.push("Reply with your answers (one message is fine). Tap Finalize plan to stop Q&A, or Cancel to abort.");
    lines.push("(You can also type FINALIZE/CANCEL.)");
  }
  lines.push(`(Expires in ~${ttlMinutes} min.)`);

  return lines.join("\n").trim();
}

async function getTelegramAgentPlanningDraft(params: {
  context: GitHubContext<"issue_comment.created">;
  kv: KvLike;
  request: string;
  answers: string[];
  previousDraft: TelegramAgentPlanningDraft | null;
  conversationContext: string;
  hasIssueContext: boolean;
  targetLabel: string | null;
  forceReady?: boolean;
  logger: Logger;
  onError: (message: string) => Promise<void>;
}): Promise<TelegramAgentPlanningDraft | null> {
  const prompt = buildTelegramAgentPlanningPrompt();
  const repoOwner = params.context.payload.repository?.owner?.login ?? "";
  const repoName = params.context.payload.repository?.name ?? "";
  const repoNotes =
    typeof repoOwner === "string" && typeof repoName === "string" && repoOwner.trim() && repoName.trim()
      ? await getOrBuildTelegramRepoNotes({
          kv: params.kv,
          octokit: params.context.octokit,
          owner: repoOwner,
          repo: repoName,
          logger: params.logger,
        })
      : null;
  const routerInput = {
    platform: "telegram",
    target: params.targetLabel ?? "",
    repositoryOwner: params.context.payload.repository.owner.login,
    repositoryName: params.context.payload.repository.name,
    issueNumber: params.context.payload.issue.number,
    issueTitle: params.context.payload.issue.title,
    issueBody: params.context.payload.issue.body,
    hasIssueContext: params.hasIssueContext,
    request: params.request,
    answers: params.answers,
    ...(params.forceReady ? { forceReady: true } : {}),
    previousDraft: params.previousDraft
      ? {
          title: params.previousDraft.title,
          questions: params.previousDraft.questions,
          plan: params.previousDraft.plan,
        }
      : null,
    repoNotes: repoNotes
      ? {
          summary: repoNotes.summary,
          inferred: repoNotes.inferred,
          languages: Object.keys(repoNotes.languages ?? {}),
        }
      : null,
    conversationContext: params.conversationContext,
  };

  try {
    const raw = await callUbqAiRouter(params.context, prompt, routerInput, {
      timeoutMs: 25_000,
    });
    const parsed = tryParseTelegramAgentPlanningOutput(raw);
    if (!parsed) {
      await params.onError("I couldn't generate a plan. Please try again.");
      return null;
    }

    const forceReady = params.forceReady === true;
    let questions: string[] = [];
    if (!forceReady && parsed.status === "need_info") {
      questions = parsed.questions;
    }
    const plan = parsed.plan ?? [];

    let agentTask = parsed.status === "ready" && parsed.agentTask ? clampAgentTask(parsed.agentTask) : "";

    if (forceReady && !agentTask) {
      const answerLines = params.answers.map((answer) => `- ${answer}`).join("\n");
      const planLines = plan.map((item) => `- ${item}`).join("\n");
      const sections: string[] = [];
      if (params.targetLabel) sections.push(`Target: ${params.targetLabel}`);
      sections.push(`Goal: ${params.request.trim()}`);
      if (answerLines) sections.push(`User-provided details:\n${answerLines}`);
      if (planLines) sections.push(`Proposed plan:\n${planLines}`);
      sections.push("Proceed with best-effort assumptions (do not ask more questions before starting).");
      sections.push("If assumptions are required, state them clearly in the final output/comment.");
      agentTask = clampAgentTask(sections.join("\n\n"));
    }

    return {
      title: parsed.title ?? "",
      questions,
      plan,
      agentTask,
    };
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 0;
    const detail = error instanceof Error ? error.message : String(error);
    const message = getErrorReply(status, detail, "relatable");
    await params.onError(message);
    return null;
  }
}

async function startTelegramAgentPlanningSession(params: {
  context: GitHubContext<"issue_comment.created">;
  botToken: string;
  chat: TelegramChat;
  threadId: number | null;
  userId: number;
  replyToMessageId: number;
  request: string;
  conversationContext: string;
  hasIssueContext: boolean;
  routing: TelegramRoutingConfig;
  routingOverride: TelegramRoutingOverride | null;
  logger: Logger;
}): Promise<void> {
  const kv = await getTelegramKv(params.logger);
  if (!kv) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "KV is unavailable, so planning mode is disabled right now.",
      logger: params.logger,
    });
    return;
  }

  const request = params.request.trim();
  if (!request) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Tell me what you want to build, and I will propose a plan.",
      logger: params.logger,
    });
    return;
  }

  const botId = getTelegramBotId(params.botToken);
  const key = buildTelegramAgentPlanningKey({
    botId,
    chatId: params.chat.id,
    threadId: params.threadId,
    userId: params.userId,
  });
  const nowMs = Date.now();
  const session: TelegramAgentPlanningSession = {
    version: 1,
    id: crypto.randomUUID(),
    status: "collecting",
    request,
    answers: [],
    draft: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + TELEGRAM_AGENT_PLANNING_TTL_MS,
  };

  const targetLabel = params.routingOverride ? describeTelegramContextLabel(params.routingOverride) : formatRoutingLabel(params.routing);

  const draft = await getTelegramAgentPlanningDraft({
    context: params.context,
    kv,
    request: session.request,
    answers: session.answers,
    previousDraft: null,
    conversationContext: params.conversationContext,
    hasIssueContext: params.hasIssueContext,
    targetLabel,
    logger: params.logger,
    onError: async (message) => {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: message,
        logger: params.logger,
      });
    },
  });
  if (!draft) {
    return;
  }

  const isReady = draft.questions.length === 0 && Boolean(draft.agentTask);
  const nextSession: TelegramAgentPlanningSession = {
    ...session,
    status: isReady ? "awaiting_approval" : "collecting",
    draft,
    updatedAtMs: Date.now(),
  };

  const didSaveSession = await saveTelegramAgentPlanningSession({
    kv,
    key,
    session: nextSession,
    logger: params.logger,
  });
  if (!didSaveSession) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "I couldn't save this plan. Please try again.",
      logger: params.logger,
    });
    return;
  }

  const message = formatTelegramAgentPlanningMessage({
    status: nextSession.status,
    title: draft.title,
    questions: draft.questions,
    plan: draft.plan,
    targetLabel,
    ttlMs: TELEGRAM_AGENT_PLANNING_TTL_MS,
  });
  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageThreadId: params.threadId ?? undefined,
    replyToMessageId: params.replyToMessageId,
    text: message,
    replyMarkup: buildTelegramAgentPlanningKeyboard({
      status: nextSession.status,
      sessionId: nextSession.id,
    }),
    logger: params.logger,
  });
}

async function maybeHandleTelegramAgentPlanningSession(params: {
  context: GitHubContext<"issue_comment.created">;
  botToken: string;
  chat: TelegramChat;
  threadId: number | null;
  userId: number;
  replyToMessageId: number;
  rawText: string;
  conversationContext: string;
  routing: TelegramRoutingConfig;
  routingOverride: TelegramRoutingOverride | null;
  channelMode: "github" | "shim";
  updateId: number;
  message: TelegramMessage;
  logger: Logger;
  hasIssueContext: boolean;
  intent?: "append" | "approve" | "cancel" | "show" | "finalize";
}): Promise<boolean> {
  const kv = await getTelegramKv(params.logger);
  if (!kv) return false;

  const botId = getTelegramBotId(params.botToken);
  const key = buildTelegramAgentPlanningKey({
    botId,
    chatId: params.chat.id,
    threadId: params.threadId,
    userId: params.userId,
  });
  const session = await loadTelegramAgentPlanningSession({
    kv,
    key,
    logger: params.logger,
  });
  if (!session) return false;

  const targetLabel = params.routingOverride ? describeTelegramContextLabel(params.routingOverride) : formatRoutingLabel(params.routing);

  const operation = params.intent ?? parseTelegramAgentPlanningKeyword(params.rawText) ?? "append";

  if (operation === "cancel") {
    await deleteTelegramAgentPlanningSession({ kv, key, logger: params.logger });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Cancelled.",
      logger: params.logger,
    });
    return true;
  }

  if (operation === "show") {
    const draft = session.draft;
    const message = formatTelegramAgentPlanningMessage({
      status: session.status,
      title: draft?.title ?? "",
      questions: draft?.questions ?? [],
      plan: draft?.plan ?? [],
      targetLabel,
      ttlMs: Math.max(1, session.expiresAtMs - Date.now()),
    });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.threadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: message,
      replyMarkup: buildTelegramAgentPlanningKeyboard({
        status: session.status,
        sessionId: session.id,
      }),
      logger: params.logger,
    });
    return true;
  }

  if (operation === "finalize") {
    const draft = await getTelegramAgentPlanningDraft({
      context: params.context,
      kv,
      request: session.request,
      answers: session.answers,
      previousDraft: session.draft,
      conversationContext: params.conversationContext,
      hasIssueContext: params.hasIssueContext,
      targetLabel,
      forceReady: true,
      logger: params.logger,
      onError: async (message) => {
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: message,
          logger: params.logger,
        });
      },
    });
    if (!draft) return true;

    const nextSession: TelegramAgentPlanningSession = {
      ...session,
      status: "awaiting_approval",
      draft,
      updatedAtMs: Date.now(),
      expiresAtMs: Date.now() + TELEGRAM_AGENT_PLANNING_TTL_MS,
    };
    const didSaveUpdatedSession = await saveTelegramAgentPlanningSession({
      kv,
      key,
      session: nextSession,
      logger: params.logger,
    });
    if (!didSaveUpdatedSession) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: "I couldn't save the updated plan. Please try again.",
        logger: params.logger,
      });
      return true;
    }

    const message = formatTelegramAgentPlanningMessage({
      status: nextSession.status,
      title: draft.title,
      questions: draft.questions,
      plan: draft.plan,
      targetLabel,
      ttlMs: TELEGRAM_AGENT_PLANNING_TTL_MS,
    });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.threadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: message,
      replyMarkup: buildTelegramAgentPlanningKeyboard({
        status: nextSession.status,
        sessionId: nextSession.id,
      }),
      logger: params.logger,
    });
    return true;
  }

  if (operation === "approve") {
    const draft = session.draft;
    if (session.status !== "awaiting_approval" || !draft?.agentTask) {
      const message = formatTelegramAgentPlanningMessage({
        status: session.status,
        title: draft?.title ?? "",
        questions: draft?.questions ?? [],
        plan: draft?.plan ?? [],
        targetLabel,
        ttlMs: Math.max(1, session.expiresAtMs - Date.now()),
      });
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        messageThreadId: params.threadId ?? undefined,
        replyToMessageId: params.replyToMessageId,
        text: message,
        replyMarkup: buildTelegramAgentPlanningKeyboard({
          status: session.status,
          sessionId: session.id,
        }),
        logger: params.logger,
      });
      return true;
    }

    let context = params.context;

    if (params.channelMode === "shim" && !params.hasIssueContext) {
      const ensured = await ensureTelegramIssueContext({
        context,
        routing: params.routing,
        routingOverride: params.routingOverride,
        updateId: params.updateId,
        message: params.message,
        rawText: session.request,
        botToken: params.botToken,
        chatId: params.chat.id,
        threadId: params.threadId ?? undefined,
        logger: params.logger,
      });
      if (!ensured.ok) {
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: ensured.error,
          logger: params.logger,
        });
        return true;
      }
      if (ensured.createdIssue) {
        const link = buildTelegramIssueLink(ensured.createdIssue);
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: link.message,
          parseMode: "HTML",
          disablePreview: true,
          logger: params.logger,
        });
      }
      context = ensured.context;
    }

    await deleteTelegramAgentPlanningSession({ kv, key, logger: params.logger });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Starting agent run.",
      logger: params.logger,
    });

    const dispatchResult = await dispatchInternalAgent(context, draft.agentTask, {
      postReply: async (body) => {
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: body,
          logger: params.logger,
        });
      },
      settingsOverrides: {
        allowedAuthorAssociations: TELEGRAM_ALLOWED_AUTHOR_ASSOCIATIONS,
      },
    });
    if (dispatchResult?.runUrl) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: `Run logs: ${dispatchResult.runUrl}`,
        logger: params.logger,
      });
    } else if (dispatchResult?.workflowUrl) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: `Workflow: ${dispatchResult.workflowUrl}`,
        logger: params.logger,
      });
    }
    return true;
  }

  const answer = params.rawText
    .trim()
    .replace(/^@ubiquityos\b\s*/i, "")
    .trim();
  if (!answer) {
    const draft = session.draft;
    const message = formatTelegramAgentPlanningMessage({
      status: session.status,
      title: draft?.title ?? "",
      questions: draft?.questions ?? [],
      plan: draft?.plan ?? [],
      targetLabel,
      ttlMs: Math.max(1, session.expiresAtMs - Date.now()),
    });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.threadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: message,
      replyMarkup: buildTelegramAgentPlanningKeyboard({
        status: session.status,
        sessionId: session.id,
      }),
      logger: params.logger,
    });
    return true;
  }

  const nextAnswers = [...session.answers, answer].filter(Boolean);
  const boundedAnswers = nextAnswers.slice(Math.max(0, nextAnswers.length - TELEGRAM_AGENT_PLANNING_MAX_ANSWERS));

  const draft = await getTelegramAgentPlanningDraft({
    context: params.context,
    kv,
    request: session.request,
    answers: boundedAnswers,
    previousDraft: session.draft,
    conversationContext: params.conversationContext,
    hasIssueContext: params.hasIssueContext,
    targetLabel,
    logger: params.logger,
    onError: async (message) => {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: message,
        logger: params.logger,
      });
    },
  });
  if (!draft) return true;

  const isReady = draft.questions.length === 0 && Boolean(draft.agentTask);
  const nextSession: TelegramAgentPlanningSession = {
    ...session,
    status: isReady ? "awaiting_approval" : "collecting",
    answers: boundedAnswers,
    draft,
    updatedAtMs: Date.now(),
    expiresAtMs: Date.now() + TELEGRAM_AGENT_PLANNING_TTL_MS,
  };
  const didSaveUpdatedSession = await saveTelegramAgentPlanningSession({
    kv,
    key,
    session: nextSession,
    logger: params.logger,
  });
  if (!didSaveUpdatedSession) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "I couldn't save the updated plan. Please try again.",
      logger: params.logger,
    });
    return true;
  }

  const message = formatTelegramAgentPlanningMessage({
    status: nextSession.status,
    title: draft.title,
    questions: draft.questions,
    plan: draft.plan,
    targetLabel,
    ttlMs: TELEGRAM_AGENT_PLANNING_TTL_MS,
  });
  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageThreadId: params.threadId ?? undefined,
    replyToMessageId: params.replyToMessageId,
    text: message,
    replyMarkup: buildTelegramAgentPlanningKeyboard({
      status: nextSession.status,
      sessionId: nextSession.id,
    }),
    logger: params.logger,
  });
  return true;
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
