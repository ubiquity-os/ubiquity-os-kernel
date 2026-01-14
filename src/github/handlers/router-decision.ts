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
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  try {
    if ("issue" in context.payload && context.payload.issue) {
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: context.payload.issue.number,
        body: message,
      });
      return;
    }
    if ("pull_request" in context.payload && context.payload.pull_request && context.payload.comment?.id) {
      await context.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
        owner,
        repo,
        pull_number: context.payload.pull_request.number,
        comment_id: context.payload.comment.id,
        body: message,
      });
      return;
    }
    context.logger.warn({ key: context.key }, "Router error handler could not determine reply target");
  } catch (replyError) {
    context.logger.warn({ err: replyError }, "Failed to post router error reply (non-fatal)");
  }
}
