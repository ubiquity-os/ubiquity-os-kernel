import { GitHubContext } from "../github/github-context.ts";
import { GitHubEventHandler } from "../github/github-event-handler.ts";
import { type RouterDecision, tryParseRouterDecision } from "../github/handlers/router-decision.ts";
import { buildRouterPrompt } from "../github/handlers/router-prompt.ts";
import { type GithubPlugin, isGithubPlugin, parsePluginIdentifier } from "../github/types/plugin-configuration.ts";
import { PluginInput } from "../github/types/plugin.ts";
import { callUbqAiRouter } from "../github/utils/ai-router.ts";
import { resolveConversationKeyForContext } from "../github/utils/conversation-graph.ts";
import { getAgentMemorySnippetForQuery } from "../github/utils/agent-memory-selector.ts";
import { getManifest } from "../github/utils/plugins.ts";
import { withKernelContextSettingsIfNeeded, withKernelContextWorkflowInputsIfNeeded } from "../github/utils/plugin-dispatch-settings.ts";
import { getErrorReply } from "../github/utils/router-error-messages.ts";
import { updateRequestCommentRunUrl } from "../github/utils/request-comment-run-url.ts";
import { dispatchWorker, dispatchWorkflowWithRunUrl, getDefaultBranch } from "../github/utils/workflow-dispatch.ts";
import { type TelegramAgentPlanningSession } from "./agent-planning.ts";
import { type Logger, type PluginCommandSummary, type PluginWithManifest, type TelegramChat } from "./handler-shared.ts";
import { clampText } from "./formatting.ts";

export async function resolveInstallationId(
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

export async function loadPluginsWithManifest(
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

export function resolvePluginCommand(pluginsWithManifest: PluginWithManifest[], commandName: string): PluginWithManifest | null {
  for (let i = pluginsWithManifest.length - 1; i >= 0; i--) {
    const candidate = pluginsWithManifest[i];
    if (candidate?.manifest?.commands?.[commandName] !== undefined) {
      return candidate;
    }
  }
  return null;
}

export async function dispatchCommandPlugin(
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

export async function getTelegramAgentMemorySnippet(params: {
  context: GitHubContext<"issue_comment.created">;
  query?: string;
  hasIssueContext: boolean;
  logger: Logger;
}): Promise<string> {
  const memoryConversation = params.hasIssueContext ? await resolveConversationKeyForContext(params.context, params.logger) : null;
  return getAgentMemorySnippetForQuery({
    context: params.context,
    owner: params.context.payload.repository.owner.login,
    repo: params.context.payload.repository.name,
    query: params.query,
    limit: 6,
    maxChars: 1200,
    scopeKey: memoryConversation?.key,
    logger: params.logger,
  });
}

export async function getTelegramRouterDecision(
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
    agentMemory: string;
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
    agentMemory: params.agentMemory,
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
    context.logger.info(
      {
        event: "telegram-router",
        command: commandName,
        operation,
      },
      `Telegram router decision: ${action}`
    );
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

export type TelegramAgentPlanningKeyword = "approve" | "cancel" | "finalize";
