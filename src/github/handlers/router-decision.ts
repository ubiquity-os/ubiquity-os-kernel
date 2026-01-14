import { GitHubContext } from "../github-context.ts";
import { callUbqAiRouter } from "../utils/ai-router.ts";
import { getErrorReply } from "../utils/router-error-messages.ts";

export type RouterDecision =
  | { action: "help" }
  | { action: "ignore" }
  | { action: "reply"; reply: string }
  | { action: "command"; command: { name: string; parameters?: unknown } }
  | { action: "agent"; task?: string };

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/```$/, "")
    .trim();
}

export function tryParseRouterDecision(raw: string): RouterDecision | null {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned) as RouterDecision;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as RouterDecision;
    } catch {
      return null;
    }
  }
}

export async function getRouterDecision(
  context: GitHubContext,
  prompt: string,
  routerInput: Record<string, unknown>
): Promise<{ raw: string; decision: RouterDecision | null } | null> {
  let raw: string;
  try {
    raw = await callUbqAiRouter(context, prompt, routerInput);
  } catch (error) {
    context.logger.error({ err: error }, "Router call failed");
    const status = (error as Error & { status?: number }).status || 0;
    const detail = (error as Error).message || "";
    await postRouterErrorReply(context, getErrorReply(status, detail, "relatable"));
    return null;
  }

  context.logger.debug({ raw }, "Router output");
  return { raw, decision: tryParseRouterDecision(raw) };
}

export async function postRouterErrorReply(context: GitHubContext, body: string) {
  const message = body.trim();
  if (!message) return;

  const payload = context.payload as Record<string, unknown>;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const owner = (repository?.owner as Record<string, unknown> | undefined)?.login as string | undefined;
  const repo = repository?.name;

  if (!owner || !repo) {
    context.logger.warn({ key: context.key }, "Router error handler could not determine repository");
    return;
  }

  // 1. Threaded Review Comment (highest priority)
  // Check both context name and key prefix to be robust
  const isReviewComment = context.name === "pull_request_review_comment" || context.key?.startsWith("pull_request_review_comment");
  const pullNumber = payload.pull_request?.number || payload.issue?.number;
  const commentId = payload.comment?.id;

  try {
    if (isReviewComment && pullNumber && commentId) {
      await context.octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        comment_id: commentId,
        body: message,
      });
      return;
    }

    // 2. Issue or Pull Request top-level comment
    // issue_comment, pull_request_review, or pull_request events
    if (pullNumber) {
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: message,
      });
      return;
    }

    context.logger.warn({ key: context.key, name: context.name }, "Router error handler could not determine reply target");
  } catch (replyError) {
    context.logger.warn({ err: replyError }, "Failed to post router error reply (non-fatal)");
  }
}
