import { GitHubContext } from "../github-context.ts";
import { PluginInput } from "../types/plugin.ts";
import { upsertAgentRunMemory } from "../utils/agent-memory.ts";
import { getAgentMemorySnippetForQuery } from "../utils/agent-memory-selector.ts";
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

const AGENT_MEMORY_SUMMARY_MAX_CHARS = 1_200;

function clampText(value: string, maxChars: number): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function getSubjectNumber(context: InternalAgentContext): number | null {
  const payload = context.payload as Record<string, unknown>;
  const issue = payload.issue as { number?: unknown } | undefined;
  const pullRequest = payload.pull_request as { number?: unknown } | undefined;
  const issueNumber = typeof issue?.number === "number" && Number.isFinite(issue.number) && issue.number > 0 ? Math.trunc(issue.number) : null;
  if (issueNumber) return issueNumber;
  if (typeof pullRequest?.number === "number" && Number.isFinite(pullRequest.number) && pullRequest.number > 0) {
    return Math.trunc(pullRequest.number);
  }
  return null;
}

function buildDispatchSummary(task: string, statusDetail: string): string {
  const taskLine = clampText(task, 420);
  const detailLine = clampText(statusDetail, 420);
  const summary = [taskLine ? `Task: ${taskLine}` : "", detailLine].filter(Boolean).join(" | ");
  return clampText(summary, AGENT_MEMORY_SUMMARY_MAX_CHARS);
}

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

  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const issueNumber = getSubjectNumber(context);
  const stateId = crypto.randomUUID();
  const persistAgentMemory = async (
    status: string,
    options: {
      summary: string;
      runUrl?: string;
      prUrl?: string;
      scopeKey?: string;
    }
  ): Promise<void> => {
    if (!issueNumber) return;
    const summary = options.summary.trim();
    if (!summary) return;
    try {
      await upsertAgentRunMemory({
        owner,
        repo,
        scopeKey: options.scopeKey,
        entry: {
          kind: "agent_run",
          stateId,
          status,
          issueNumber,
          updatedAt: new Date().toISOString(),
          ...(options.runUrl ? { runUrl: options.runUrl } : {}),
          ...(options.prUrl ? { prUrl: options.prUrl } : {}),
          summary,
        },
        logger: context.logger,
      });
    } catch (error) {
      context.logger.debug({ err: error, stateId, status }, "Failed to persist agent dispatch memory (non-fatal)");
    }
  };

  try {
    const ref = context.eventHandler.agent.ref?.trim() || (await getDefaultBranch(context, agentOwner, agentRepo));
    const token = await context.eventHandler.getToken(context.payload.installation.id);
    const conversation = await resolveConversationKeyForContext(context, context.logger);
    const conversationContext = conversation
      ? await buildConversationContext({
          context,
          conversation,
          maxItems: 8,
          maxChars: 3200,
          query: task,
          useSelector: true,
        })
      : "";
    const agentMemory = await getAgentMemorySnippetForQuery({
      context,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      query: task,
      limit: 6,
      maxChars: 1200,
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
    await persistAgentMemory("run-dispatched", {
      scopeKey: conversation?.key,
      runUrl: runUrl ?? undefined,
      summary: buildDispatchSummary(task, "Agent run dispatched"),
    });
    return { runUrl, workflowUrl: agentWorkflowUrl };
  } catch (error) {
    context.logger.error({ err: error }, "Failed to dispatch internal agent workflow");
    const message = error instanceof Error ? error.message : String(error);
    await persistAgentMemory("dispatch-failed", {
      summary: buildDispatchSummary(task, `Dispatch failed: ${message}`),
    });
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
