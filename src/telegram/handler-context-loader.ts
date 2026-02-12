import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubContext } from "../github/github-context.ts";
import { GitHubEventHandler } from "../github/github-event-handler.ts";
import { type Env } from "../github/types/env.ts";
import type { PluginConfiguration } from "../github/types/plugin-configuration.ts";
import { type AgentConfig, type AiConfig, type KernelConfig } from "../github/utils/env-config.ts";
import { type GitHubAppConfig } from "../github/utils/github-app-config.ts";
import { CONFIG_FULL_PATH, CONFIG_ORG_REPO, getConfig, getConfigurationFromRepo } from "../github/utils/config.ts";
import { normalizeLogin } from "./normalization.ts";
import { type TelegramLinkedIdentity } from "./identity-store.ts";
import { type TelegramRoutingConfig } from "./routing-context.ts";
import { type Logger, type PluginCommandSummary, type PluginWithManifest, type TelegramMessage } from "./handler-shared.ts";
import { getTelegramAuthor } from "./formatting.ts";
import { hydrateTelegramIssuePayload } from "./handler-issue-context.ts";
import { loadPluginsWithManifest, resolveInstallationId } from "./handler-plugin-router.ts";

export async function createGitHubContext(params: {
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
  eventHandlerOverride?: GitHubEventHandler;
}): Promise<
  | {
      ok: true;
      context: GitHubContext<"issue_comment.created">;
      pluginsWithManifest: PluginWithManifest[];
      manifests: PluginWithManifest["manifest"][];
      hasIssueContext: boolean;
      pluginSummary: PluginCommandSummary;
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
      llm: "gpt-5.3-codex",
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
    repository: {
      owner: { login: owner },
      name: repo,
      full_name: `${owner}/${repo}`,
    },
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
  if (!targetConfig) {
    return {
      ok: false,
      error: "No kernel configuration was found for Telegram routing.",
    };
  }
  if (!kernelConfigOverride) {
    const configSources =
      (
        targetConfig as {
          __sources?: Array<{ owner: string; repo: string; path: string }>;
        }
      ).__sources ?? [];
    if (!configSources.length) {
      return {
        ok: false,
        error: `No .ubiquity-os config found for ${owner}/${repo}. Add ${owner}/${CONFIG_ORG_REPO}/${CONFIG_FULL_PATH} first.`,
      };
    }
  }

  const { pluginsWithManifest, manifests, summary: pluginSummary } = await loadPluginsWithManifest(context, targetConfig.plugins);
  return {
    ok: true,
    context,
    pluginsWithManifest,
    manifests,
    hasIssueContext,
    pluginSummary,
  };
}

export async function loadKernelConfigForOwner(params: {
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
    }
  | { ok: false; error: string }
> {
  const { owner, env, logger, githubConfig, aiConfig, agentConfig, kernelConfig, kernelRefreshUrl } = params;
  const eventHandler = new GitHubEventHandler({
    environment: env.ENVIRONMENT,
    webhookSecret: githubConfig.webhookSecret,
    appId: githubConfig.appId,
    privateKey: githubConfig.privateKey,
    llm: "gpt-5.3-codex",
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
    return {
      ok: false,
      error: `No .ubiquity-os config found for ${owner}/${CONFIG_ORG_REPO}. Add ${owner}/${CONFIG_ORG_REPO}/${CONFIG_FULL_PATH} first.`,
    };
  }

  return { ok: true, config, eventHandler };
}
