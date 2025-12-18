import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { GithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import {
  callUbqAiRouter,
  describeCommands,
  extractAfterUbiquityosMention,
  getIssueLabelNames,
  truncateForRouter,
  tryParseRouterDecision,
} from "./issue-comment-created";

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
  await context.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    pull_number: context.payload.pull_request.number,
    comment_id: context.payload.comment.id,
    body: message,
  });
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

async function dispatchInternalAgent(context: GitHubContext<"pull_request_review_comment.created">, task: string) {
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
    const ref = await getDefaultBranch(context, agentOwner, agentRepo);
    const token = await context.eventHandler.getToken(context.payload.installation.id);
    const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, {}, token, ref, { name: "agent", parameters: { task } });

    await dispatchWorkflow(context, {
      owner: agentOwner,
      repository: agentRepo,
      workflowId: agentWorkflowId,
      ref,
      inputs: await inputs.getInputs(),
    });
  } catch (error) {
    context.logger.error({ err: error }, "Failed to dispatch internal agent workflow");
    const message = error instanceof Error ? error.message : String(error);
    await postReplyInReviewThread(
      context,
      [
        "I couldn't start the agent run.",
        message ? `Error: ${message}` : null,
        "",
        `Actions workflow: ${agentWorkflowUrl}`,
        "",
        "If you're testing a feature branch, note that GitHub's workflow_dispatch API only triggers workflows that exist on the repo's default branch.",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

export default async function pullRequestReviewCommentCreated(context: GitHubContext<"pull_request_review_comment.created">) {
  const body = context.payload.comment.body?.trim() ?? "";
  const afterMention = extractAfterUbiquityosMention(body);
  if (afterMention === null) return;

  if (context.payload.comment.user?.type === "User") {
    await addReactionEyes(context);
  }

  const config = await getConfig(context);
  if (!config) {
    context.logger.debug("No configuration was found");
    return;
  }

  const manifests: Manifest[] = [];
  for (const [pluginKey] of Object.entries(config.plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    const manifest = await getManifest(context, target);
    if (!manifest?.commands) continue;
    manifests.push(manifest);
  }

  const commands = describeCommands(manifests);
  const recentComments = await getReviewThreadCommentsForRouter(context, 10);
  const labels = getIssueLabelNames((context.payload.pull_request as unknown as { labels?: unknown }).labels);
  const issueBody = truncateForRouter(context.payload.pull_request.body);

  const prompt = `
You are **UbiquityOS**, a GitHub App assistant.

You will receive a single JSON object with:
- repositoryOwner
- repositoryName
- issueNumber
- issueTitle
- issueBody (issue/PR body/spec)
- isPullRequest
- labels (current label names)
- recentComments (array of comments in the current PR review thread: { author, body })
- author
- comment (a GitHub comment that mentions "@ubiquityos")

You also have access to a list of available commands (including their examples and JSON parameter schemas).

Return **ONLY** a JSON object matching ONE of these shapes (no markdown, no code fences):

1) Help:
{ "action": "help" }

2) Ignore:
{ "action": "ignore" }

3) Plain reply (post a reply in the review thread):
{ "action": "reply", "reply": "..." }

4) Escalate to the full agent runner (for complex, multi-step, repo edits, or label/spec work):
{ "action": "agent", "task": "..." }

Rules:
- Use "help" when asked for available commands / how to use.
- Use "reply" for questions, discussion, or research that doesn't need execution.
- Use "agent" for anything that requires repo changes, reading long threads, rewriting specs, setting labels/time estimates, or GitHub operations.
- If parameters are unclear, use "reply" to ask a single clarifying question AND include a copy/paste follow-up that starts with "@ubiquityos" and is fully self-contained.

Available commands (JSON):
${JSON.stringify(commands)}
`.trim();

  let raw: string;
  try {
    raw = await callUbqAiRouter(context, prompt, {
      repositoryOwner: context.payload.repository.owner.login,
      repositoryName: context.payload.repository.name,
      issueNumber: context.payload.pull_request.number,
      issueTitle: context.payload.pull_request.title,
      issueBody,
      isPullRequest: true,
      labels,
      recentComments,
      author: context.payload.comment.user?.login,
      comment: context.payload.comment.body,
    });
  } catch (error) {
    context.logger.error({ err: error }, "Router call failed");
    await postReplyInReviewThread(context, "I couldn't reach the router model right now. Please try again in a moment.");
    return;
  }

  context.logger.debug({ raw }, "Router output");

  const decision = tryParseRouterDecision(raw);
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

  const task = String((decision as { task?: unknown }).task ?? "").trim() || afterMention || body;
  await dispatchInternalAgent(context, task);
}
