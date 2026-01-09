import { GitHubContext } from "../github-context.ts";

const RUN_LOGS_LABEL = "Run logs:";
const RUN_LOGS_LINE_REGEX = /^\s*Run logs:\s*.*(?:\r?\n)?/gim;
const AGENT_BLOCK_REGEX = /<!--\s*ubiquityos-agent[\s\S]*?-->/u;

function stripVisibleRunLogsLines(body: string): string {
  return body.replace(RUN_LOGS_LINE_REGEX, "");
}

function upsertRunLogsInAgentBlock(block: string, runUrl: string): string {
  const cleaned = block.replace(/^<!--\s*ubiquityos-agent\s*/u, "").replace(/-->\s*$/u, "");
  const lines = cleaned.split(/\r?\n/u);
  const nextLines: string[] = [];
  let didWrite = false;

  for (const line of lines) {
    if (line.trim().startsWith(RUN_LOGS_LABEL)) {
      if (!didWrite) {
        nextLines.push(`${RUN_LOGS_LABEL} ${runUrl}`);
        didWrite = true;
      }
      continue;
    }
    nextLines.push(line);
  }

  if (!didWrite) {
    const summaryIndex = nextLines.findIndex((line) => line.trim() === "Agent summary:");
    const insertAt = summaryIndex >= 0 ? summaryIndex : nextLines.length;
    nextLines.splice(insertAt, 0, `${RUN_LOGS_LABEL} ${runUrl}`);
  }

  const content = nextLines.join("\n").trimEnd();
  return `<!-- ubiquityos-agent\n${content}\n-->`;
}

export async function updateRequestCommentRunUrl(
  context: GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">,
  runUrl: string | null | undefined
): Promise<void> {
  const trimmedUrl = runUrl?.trim() ?? "";

  const comment = context.payload.comment;
  if (!comment?.body || !comment.id) return;

  const match = AGENT_BLOCK_REGEX.exec(comment.body);
  let updatedBody = comment.body;
  if (match) {
    const block = match[0];
    const before = comment.body.slice(0, match.index);
    const after = comment.body.slice(match.index + block.length);
    if (trimmedUrl) {
      const updatedBlock = upsertRunLogsInAgentBlock(block, trimmedUrl);
      updatedBody = `${stripVisibleRunLogsLines(before)}${updatedBlock}${stripVisibleRunLogsLines(after)}`;
    } else {
      const cleanedBlock = block.replace(RUN_LOGS_LINE_REGEX, "");
      updatedBody = `${stripVisibleRunLogsLines(before)}${cleanedBlock}${stripVisibleRunLogsLines(after)}`;
    }
  } else {
    updatedBody = stripVisibleRunLogsLines(comment.body);
  }
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
