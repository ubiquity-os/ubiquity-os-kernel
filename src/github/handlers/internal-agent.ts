import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { getAgentMemorySnippet } from "../utils/agent-memory";
import { getConfigPathCandidatesForEnvironment } from "../utils/config";
import { resolveConversationKeyForContext } from "../utils/conversation-graph";
import { buildConversationContext } from "../utils/conversation-context";
import { isPrivilegedAuthorAssociation, tryGetInstallationTokenForOwner } from "../utils/marketplace-auth";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url";
import { dispatchWorkflowWithRunUrl, getDefaultBranch } from "../utils/workflow-dispatch";

type InternalAgentContext = GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">;

type DispatchInternalAgentOptions = Readonly<{
  postReply: (body: string) => Promise<void>;
  settingsOverrides?: Record<string, unknown>;
}>;

export async function dispatchInternalAgent(
  context: InternalAgentContext,
  task: string,
  { postReply, settingsOverrides }: DispatchInternalAgentOptions
): Promise<void> {
  const agentOwner = context.eventHandler.agent.owner;
  const agentRepo = context.eventHandler.agent.repo;
  const agentWorkflowId = context.eventHandler.agent.workflowId;
  const agentWorkflowUrl = `https://github.com/${agentOwner}/${agentRepo}/actions/workflows/${agentWorkflowId}`;

  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    context.logger.warn("No installation found, cannot dispatch agent");
    return;
  }

  try {
    const stateId = crypto.randomUUID();
    const ref = context.eventHandler.agent.ref?.trim() || (await getDefaultBranch(context, agentOwner, agentRepo));
    const token = await context.eventHandler.getToken(context.payload.installation.id);
    const conversation = await resolveConversationKeyForContext(context, context.logger);
    const conversationContext = conversation
      ? await buildConversationContext({ context, conversation, maxItems: 8, maxChars: 3200, query: task, useSelector: true })
      : "";
    const agentMemory = await getAgentMemorySnippet({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      scopeKey: conversation?.key,
      logger: context.logger,
    });
    const kernelRefreshUrl = context.eventHandler.kernelRefreshUrl.trim();
    const kernelRefreshIntervalSeconds = context.eventHandler.kernelRefreshIntervalSeconds;
    const baseSettings: Record<string, unknown> = {
      ...(agentMemory ? { agentMemory } : {}),
      ...(conversationContext ? { conversationContext } : {}),
      ...(conversation?.key ? { conversationKey: conversation.key } : {}),
      environment: context.eventHandler.environment,
      ...(kernelRefreshUrl ? { kernelRefreshUrl } : {}),
      ...(Number.isFinite(kernelRefreshIntervalSeconds) ? { kernelRefreshIntervalSeconds } : {}),
      configPathCandidates: getConfigPathCandidatesForEnvironment(context.eventHandler.environment),
      ...(settingsOverrides ?? {}),
    };

    const marketplaceOrg = typeof baseSettings.marketplaceOrg === "string" ? baseSettings.marketplaceOrg.trim() : "ubiquity-os-marketplace";
    const shouldUseMarketplaceToken = isPrivilegedAuthorAssociation(context.payload.comment.author_association);
    let marketplaceAuthToken: string | null = null;
    if (shouldUseMarketplaceToken) {
      try {
        marketplaceAuthToken = await tryGetInstallationTokenForOwner(context.eventHandler, marketplaceOrg);
      } catch (error) {
        context.logger.debug({ err: error, marketplaceOrg }, "Failed to mint marketplace installation token (non-fatal)");
      }
    }

    const settings = {
      ...baseSettings,
      marketplaceOrg,
      ...(marketplaceAuthToken ? { marketplaceAuthToken } : {}),
    };
    const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, ref, {
      name: "agent",
      parameters: { task },
    });

    const runUrl = await dispatchWorkflowWithRunUrl(context, {
      owner: agentOwner,
      repository: agentRepo,
      workflowId: agentWorkflowId,
      ref,
      inputs: await inputs.getInputs(),
    });
    await updateRequestCommentRunUrl(context, runUrl);
  } catch (error) {
    context.logger.error({ err: error }, "Failed to dispatch internal agent workflow");
    const message = error instanceof Error ? error.message : String(error);
    await postReply(
      [
        "I couldn't start the agent run.",
        message ? `Error: ${message}` : null,
        "",
        `Actions workflow: ${agentWorkflowUrl}`,
        "",
        "If you're testing a feature branch, set `UOS_AGENT_REF` to that branch and ensure the workflow file exists at that ref.",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}
