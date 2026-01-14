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

async function postRouterErrorReply(context: GitHubContext, body: string) {
  const message = body.trim();
  if (!message) return;

  const payload = context.payload as Record<string, unknown>;
  const repository = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
  const owner = repository?.owner?.login;
  const repo = repository?.name;

  if (!owner || !repo) {
    context.logger.warn({ key: context.key }, "Router error handler could not determine repository");
    return;
  }

  const comment = payload.comment as { id: number } | undefined;
  if (!comment) {
    context.logger.info({ key: context.key }, "Router error handler skipped: no comment in payload");
    return;
  }

  const issue = payload.issue as { number: number } | undefined;
  const pullRequest = payload.pull_request as { number: number } | undefined;

  try {
    // PR Review Comment (reply to specific thread)
    if (pullRequest?.number && context.name === "pull_request_review_comment") {
      await context.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
        owner,
        repo,
        pull_number: pullRequest.number,
        comment_id: comment.id,
        body: message,
      });
      return;
    }

    // Issue OR Pull Request top-level comment (issue_comment event)
    if (issue?.number) {
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: message,
      });
      return;
    }

    context.logger.warn({ key: context.key }, "Router error handler could not determine reply target");
  } catch (replyError) {
    context.logger.warn({ err: replyError }, "Failed to post router error reply (non-fatal)");
  }
}
