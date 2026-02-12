import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { logger as baseLogger } from "../logger/logger.ts";
import { type GithubPlugin } from "../github/types/plugin-configuration.ts";
import type { PluginConfiguration } from "../github/types/plugin-configuration.ts";
import { type KvKey } from "../github/utils/kv-client.ts";

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramChat = {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  is_forum?: boolean;
};

export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;
  chat: TelegramChat;
};

export type TelegramChatMember = {
  user: TelegramUser;
  status?: string;
};

export type TelegramChatMemberUpdated = {
  chat: TelegramChat;
  from?: TelegramUser;
  date?: number;
  old_chat_member?: TelegramChatMember;
  new_chat_member?: TelegramChatMember;
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: TelegramChatMemberUpdated;
  chat_member?: TelegramChatMemberUpdated;
};

export type TelegramSecretsConfig = {
  botToken: string;
  webhookSecret?: string;
  apiId?: number;
  apiHash?: string;
  userSession?: string;
  // Telegram file_id (not URL) to use for workspace group avatars.
  // Using a file_id is extremely efficient: no image assets stored in the repo and no uploads per group.
  workspacePhotoFileId?: string;
};

export type PluginWithManifest = {
  target: string | GithubPlugin;
  settings: Record<string, unknown> | null | undefined;
  manifest: Manifest;
};

export type PluginCommandSummary = {
  total: number;
  withCommands: number;
  missingManifest: number;
  noCommands: number;
  invalid: number;
  skippedBotEvents: number;
};

export function mergePluginConfigurations(base: PluginConfiguration, override: PluginConfiguration): PluginConfiguration {
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

export const TELEGRAM_SESSION_TITLE_MAX_CHARS = 120;
export const TELEGRAM_SESSION_BODY_MAX_CHARS = 8000;
export const TELEGRAM_FORUM_TOPIC_NAME_MAX_CHARS = 128;
export const TELEGRAM_FORUM_TOPIC_CREATE_ERROR = "Couldn't create a topic.";
export const TELEGRAM_AGENT_PLANNING_CALLBACK_PREFIX = "uos_agent_plan";
export const TELEGRAM_LINK_RETRY_CALLBACK_PREFIX = "link:retry:";
export const TELEGRAM_LINK_START_CALLBACK_DATA = "link:start";
export const TELEGRAM_NO_ACTIVE_PLAN_FOUND_ERROR = "No active plan found.";
export const TELEGRAM_START_LINKING_LABEL = "Start linking";
export const TELEGRAM_PROMOTION_NOT_ENOUGH_RIGHTS_DESCRIPTION = "not enough rights";
export const TELEGRAM_BOT_NOT_MEMBER_DESCRIPTION = "bot is not a member";
export const TELEGRAM_SET_CHAT_PHOTO_ERROR = "Couldn't set the workspace photo.";
export const TELEGRAM_ALLOWED_AUTHOR_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "NONE"];
export const TELEGRAM_CONTEXT_SAVE_ERROR = "I couldn't save that context. Please try again.";

// TODO: Swap this shim registry for org plugin-derived commands once GitHub wiring lands.
export const TELEGRAM_SHIM_COMMANDS = [
  {
    name: "_status",
    description: "Developer: check account link status.",
    example: "/_status",
  },
  {
    name: "_ping",
    description: "Developer: check if the bot is alive.",
    example: "/_ping",
  },
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

export const TELEGRAM_COMMAND_SYNC_MIN_INTERVAL_MS = 60_000;
export const TELEGRAM_AGENT_PLANNING_TTL_MS = 30 * 60_000;
export const TELEGRAM_AGENT_PLANNING_MAX_ANSWERS = 12;
export const TELEGRAM_AGENT_TASK_MAX_CHARS = 40_000;

export const telegramCommandSyncState: {
  lastSignature?: string;
  lastSyncAt?: number;
} = {};

export const TELEGRAM_CONTEXT_PREFIX: KvKey = ["ubiquityos", "telegram", "context"];

export const telegramKvState = {
  hasTelegramKvWarningIssued: false,
};

export type Logger = typeof baseLogger;

export function normalizeTelegramUserCommandName(value: string): string {
  return value.trim().toLowerCase();
}
