import { GitHubContext } from "../github-context.ts";
import { PluginInput } from "../types/plugin.ts";
import { getAgentMemorySnippet } from "../utils/agent-memory.ts";
import { getConfigPathCandidatesForEnvironment } from "../utils/config.ts";
import { resolveConversationKeyForContext } from "../utils/conversation-graph.ts";
import { buildConversationContext } from "../utils/conversation-context.ts";
import { isPrivilegedAuthorAssociation, tryGetInstallationTokenForOwner } from "../utils/marketplace-auth.ts";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url.ts";
import { dispatchWorkflowWithRunUrl, getDefaultBranch } from "../utils/workflow-dispatch.ts";

type InternalAgentContext = GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">;

type DispatchInternalAgentOptions = Readonly<{
  postReply: (body: string) => Promise<void>;
  settingsOverrides?: Record<string, unknown>;
}>;

export type InternalAgentDispatchResult = Readonly<{
  runUrl: string | null;
  workflowUrl: string;
}>;

export async function dispatchInternalAgent(
  context: InternalAgentContext,
  task: string,
  { postReply, settingsOverrides }: DispatchInternalAgentOptions
): Promise<InternalAgentDispatchResult | null> {
  const agentOwner = context.eventHandler.agent.owner;
  const agentRepo = context.eventHandler.agent.repo;
  const agentWorkflowId = context.eventHandler.agent.workflowId;
  const agentWorkflowUrl = `https://github.com/${agentOwner}/${agentRepo}/actions/workflows/${agentWorkflowId}`;

  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    context.logger.warn("No installation found, cannot dispatch agent");
    return null;
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
      // Defaults tuned for ai.ubq.fi (ChatGPT Codex upstream).
      // `xhigh` reasoning can be unsupported/unstable on some Codex models, so default to `high`.
      model: "gpt-5.3-codex",
      effort: "high",
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
    return { runUrl, workflowUrl: agentWorkflowUrl };
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
        "If you're testing a feature branch, set `UOS_AGENT.ref` in `UOS_AGENT` and ensure the workflow file exists at that ref.",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return null;
  }
}
