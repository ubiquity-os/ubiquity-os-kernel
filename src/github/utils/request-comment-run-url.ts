import { GitHubContext } from "../github-context";

const RUN_LOGS_LABEL = "Run logs:";
const RUN_LOGS_REGEX = /^\s*Run logs:\s*.*$/im;

function upsertRunLogsLine(body: string, runUrl: string): string {
  if (RUN_LOGS_REGEX.test(body)) {
    return body.replace(RUN_LOGS_REGEX, `${RUN_LOGS_LABEL} ${runUrl}`);
  }

  const separator = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}${RUN_LOGS_LABEL} ${runUrl}`;
}

export async function updateRequestCommentRunUrl(
  context: GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">,
  runUrl: string | null | undefined
): Promise<void> {
  const trimmedUrl = runUrl?.trim();
  if (!trimmedUrl) return;

  const comment = context.payload.comment;
  if (!comment?.body || !comment.id) return;

  const updatedBody = upsertRunLogsLine(comment.body, trimmedUrl);
  if (updatedBody === comment.body) return;

  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;

  try {
    if (context.key === "pull_request_review_comment.created") {
      await context.octokit.rest.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: comment.id,
        body: updatedBody,
      });
      return;
    }

    await context.octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: comment.id,
      body: updatedBody,
    });
  } catch (error) {
    context.logger.debug({ err: error, commentId: comment.id }, "Failed to update request comment with run URL (non-fatal)");
  }
}
