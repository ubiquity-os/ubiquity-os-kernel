import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context.ts";
import { PluginInput } from "../types/plugin.ts";
import { GithubPlugin, PluginSettings, isGithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration.ts";
import { getAgentMemorySnippet } from "../utils/agent-memory.ts";
import { shouldSkipDuplicateCommentEvent } from "../utils/comment-dedupe.ts";
import { getConfig } from "../utils/config.ts";
import { getManifest } from "../utils/plugins.ts";
import { withKernelContextSettingsIfNeeded, withKernelContextWorkflowInputsIfNeeded } from "../utils/plugin-dispatch-settings.ts";
import { dispatchWorker, dispatchWorkflowWithRunUrl, getDefaultBranch } from "../utils/workflow-dispatch.ts";
import {
  describeCommands,
  extractAfterUbiquityosMention,
  extractSlashCommandInvocation,
  getIssueLabelNames,
  parseSlashCommandParameters,
  truncateForRouter,
} from "./issue-comment-created.ts";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url.ts";
import { resolveConversationKeyForContext } from "../utils/conversation-graph.ts";
import { buildConversationContext } from "../utils/conversation-context.ts";
import { dispatchInternalAgent } from "./internal-agent.ts";
import { buildRouterPrompt } from "./router-prompt.ts";
import { getRouterDecision } from "./router-decision.ts";

async function addReactionEyes(context: GitHubContext<"pull_request_review_comment.created">) {
  const commentId = context.payload.comment.id;
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  try {
    await context.octokit.request("POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions", {
      owner,
      repo,
      comment_id: commentId,
      content: "eyes",
    });
  } catch (error) {
    context.logger.debug({ err: error }, "Failed to add 👀 reaction (non-fatal)");
  }
}

async function postReplyInReviewThread(context: GitHubContext<"pull_request_review_comment.created">, body: string) {
  const message = body.trim();
  if (!message) return;
  try {
    await context.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      pull_number: context.payload.pull_request.number,
      comment_id: context.payload.comment.id,
      body: message,
    });
  } catch (error) {
    context.logger.error(
      {
        err: error,
        pullRequest: context.payload.pull_request.number,
        commentId: context.payload.comment.id,
      },
      "Failed to post reply in review thread"
    );
  }
}

function hasLabels(value: unknown): value is { labels?: unknown } {
  return typeof value === "object" && value !== null && "labels" in value;
}

type ReviewThreadComment = {
  id: number;
  in_reply_to_id?: number;
  body?: string;
  user?: { login?: string; type?: string };
  created_at?: string;
};

async function getReviewThreadCommentsForRouter(
  context: GitHubContext<"pull_request_review_comment.created">,
  limit: number
): Promise<{ author: string; body: string }[]> {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const pull_number = context.payload.pull_request.number;
  const rootId = context.payload.comment.in_reply_to_id ?? context.payload.comment.id;

  try {
    const thread = new Map<number, ReviewThreadComment>();

    try {
      const { data: root } = await context.octokit.request("GET /repos/{owner}/{repo}/pulls/comments/{comment_id}", {
        owner,
        repo,
        comment_id: rootId,
      });
      if (root?.id) thread.set(root.id, root as ReviewThreadComment);
    } catch (error) {
      context.logger.debug({ err: error }, "Failed to fetch root review comment (non-fatal)");
    }

    const { data } = await context.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
      owner,
      repo,
      pull_number,
      per_page: 100,
      sort: "created",
      direction: "desc",
    });

    for (const comment of data as ReviewThreadComment[]) {
      if (comment.id === rootId || comment.in_reply_to_id === rootId) {
        thread.set(comment.id, comment);
      }
    }

    return [...thread.values()]
      .filter((comment) => comment.user?.type === "User")
      .sort((a, b) => {
        const aTime = a.created_at ? Date.parse(a.created_at) : 0;
        const bTime = b.created_at ? Date.parse(b.created_at) : 0;
        return aTime - bTime;
      })
      .slice(-limit)
      .map((comment) => ({
        author: comment.user?.login ?? "unknown",
        body: comment.body ?? "",
      }));
  } catch (error) {
    context.logger.debug({ err: error }, "Failed to fetch review thread comments for router (non-fatal)");
    return [];
  }
}

type ReviewCommandMatch = {
  target: string | GithubPlugin;
  settings: PluginSettings;
  manifest: Manifest;
  resolvedCommandName: string;
};

function resolveReviewCommandMatch(
  pluginsWithManifest: { target: string | GithubPlugin; settings: PluginSettings; manifest: Manifest }[],
  commandName: string
): ReviewCommandMatch | null {
  const requested = commandName.toLowerCase();
  for (let i = pluginsWithManifest.length - 1; i >= 0; i--) {
    const candidate = pluginsWithManifest[i];
    const resolvedCommandName =
      Object.keys(candidate.manifest.commands ?? {}).find((name) => name.toLowerCase() === requested) ??
      (candidate.manifest.commands?.[commandName] ? commandName : null);
    if (!resolvedCommandName) continue;
    return {
      ...candidate,
      resolvedCommandName,
    };
  }
  return null;
}

async function dispatchReviewCommand(
  context: GitHubContext<"pull_request_review_comment.created">,
  match: ReviewCommandMatch,
  parameters: unknown
): Promise<void> {
  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    await postReplyInReviewThread(context, "I couldn't run that command because the GitHub App installation context is missing.");
    return;
  }

  const command = {
    name: match.resolvedCommandName,
    parameters,
  };

  const isBotAuthor = context.payload.comment.user?.type !== "User";
  if (isBotAuthor && match.settings?.skipBotEvents) {
    context.logger.debug({ plugin: match.target, command: match.resolvedCommandName }, "Skipping review command dispatch from bot author");
    return;
  }

  const plugin = match.target;
  const settings = withKernelContextSettingsIfNeeded(match.settings?.with, plugin, context.eventHandler.environment);

  const isGithubPluginObject = isGithubPlugin(plugin);
  const stateId = crypto.randomUUID();
  const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
  const token = await context.eventHandler.getToken(context.payload.installation.id);
  const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, ref, command);

  context.logger.info({ plugin, isGithubPluginObject, command }, "Will dispatch command plugin from review thread.");
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
    await postReplyInReviewThread(context, "That command failed to start. Check kernel logs for details.");
  }
}

export default async function pullRequestReviewCommentCreated(context: GitHubContext<"pull_request_review_comment.created">) {
  const body = context.payload.comment.body?.trim() ?? "";
  const afterMention = extractAfterUbiquityosMention(body);
  const slashInvocation = afterMention ? extractSlashCommandInvocation(afterMention) : extractSlashCommandInvocation(body);

  const isHuman = context.payload.comment.user?.type === "User";
  if (!isHuman) {
    context.logger.debug(
      { author: context.payload.comment.user?.login, type: context.payload.comment.user?.type },
      "Ignoring review comment from non-human author"
    );
    return;
  }

  const shouldSkip = await shouldSkipDuplicateCommentEvent({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    eventName: context.key,
    commentId: context.payload.comment.id,
  });
  if (shouldSkip) {
    context.logger.info({ commentId: context.payload.comment.id }, "Skipping duplicate review comment event");
    return;
  }

  if (afterMention) {
    await addReactionEyes(context);
  }

  const agentPrefixMatch = afterMention ? /^agent\b/i.exec(afterMention) : null;
  if (agentPrefixMatch && afterMention) {
    const task = afterMention.replace(/^agent\b/i, "").trim() || body;
    await dispatchInternalAgent(context, task, { postReply: (reply) => postReplyInReviewThread(context, reply) });
    return;
  }

  if (!afterMention && !slashInvocation) return;

  const config = await getConfig(context);
  if (!config) {
    context.logger.debug("No configuration was found");
    return;
  }

  const pluginsWithManifest: { target: string | GithubPlugin; settings: PluginSettings; manifest: Manifest }[] = [];
  const manifests: Manifest[] = [];
  for (const [pluginKey, pluginSettings] of Object.entries(config.plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    const manifest = await getManifest(context, target);
    if (!manifest?.commands) continue;
    pluginsWithManifest.push({ target, settings: pluginSettings, manifest });
    manifests.push(manifest);
  }

  if (slashInvocation) {
    if (slashInvocation.name.toLowerCase() === "help") {
      await postReplyInReviewThread(context, "Use `/help` in the PR conversation (top-level comments) to list all available commands.");
      return;
    }

    const match = resolveReviewCommandMatch(pluginsWithManifest, slashInvocation.name);
    if (!match) {
      await postReplyInReviewThread(
        context,
        `I couldn't find a plugin for \`/${slashInvocation.name}\`. Use \`/help\` in the PR conversation to see commands.`
      );
      return;
    }

    const manifestCommand = match.manifest.commands?.[match.resolvedCommandName];
    const parameters = parseSlashCommandParameters(match.resolvedCommandName, slashInvocation.rawArgs, manifestCommand?.parameters, context);
    await dispatchReviewCommand(context, match, parameters);
    return;
  }

  if (afterMention === null) return;

  const commands = describeCommands(manifests);
  const recentComments = await getReviewThreadCommentsForRouter(context, 10);
  const labels = getIssueLabelNames(hasLabels(context.payload.pull_request) ? context.payload.pull_request.labels : undefined);
  const issueBody = truncateForRouter(context.payload.pull_request.body);
  const conversation = await resolveConversationKeyForContext(context, context.logger);
  const conversationContext = conversation ? await buildConversationContext({ context, conversation, maxItems: 5, maxChars: 1600 }) : "";
  const agentMemory = await getAgentMemorySnippet({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    limit: 6,
    maxChars: 1200,
    scopeKey: conversation?.key,
    logger: context.logger,
  });

  const prompt = buildRouterPrompt({
    commands,
    recentCommentsDescription: "array of comments in the current PR review thread: { author, body }",
    replyActionDescription: "post a reply in the review thread",
  });

  const routerResult = await getRouterDecision(context, prompt, {
    repositoryOwner: context.payload.repository.owner.login,
    repositoryName: context.payload.repository.name,
    issueNumber: context.payload.pull_request.number,
    issueTitle: context.payload.pull_request.title,
    issueBody,
    isPullRequest: true,
    labels,
    recentComments,
    agentMemory,
    conversationContext,
    author: context.payload.comment.user?.login,
    comment: context.payload.comment.body,
  });
  if (!routerResult) return;
  const { raw, decision } = routerResult;
  if (!decision) {
    await postReplyInReviewThread(context, raw);
    return;
  }

  if (decision.action === "ignore") return;
  if (decision.action === "help") {
    await postReplyInReviewThread(context, "Use `/help` in the PR conversation (top-level comments) to list all available commands.");
    return;
  }
  if (decision.action === "reply") {
    await postReplyInReviewThread(context, decision.reply);
    return;
  }
  if (decision.action === "command") {
    const commandName = decision.command?.name;
    if (!commandName || typeof commandName !== "string") {
      await postReplyInReviewThread(context, "I couldn't determine which command to run. Try `@ubiquityos help` in the PR conversation.");
      return;
    }

    const match = resolveReviewCommandMatch(pluginsWithManifest, commandName);
    if (!match) {
      await postReplyInReviewThread(context, `I couldn't find a plugin for \`/${commandName}\`. Use \`/help\` in the PR conversation to see commands.`);
      return;
    }

    await dispatchReviewCommand(context, match, decision.command?.parameters ?? null);
    return;
  }

  const task = String((decision as { task?: unknown }).task ?? "").trim() || afterMention || body;
  await dispatchInternalAgent(context, task, { postReply: (reply) => postReplyInReviewThread(context, reply) });
}
