import { GitHubContext } from "../github-context";
import { handleAgentRunCommentEdited } from "./agent-run-comment";

export default async function pullRequestReviewCommentEdited(context: GitHubContext<"pull_request_review_comment.edited">) {
  await handleAgentRunCommentEdited(context, context.payload.pull_request.number);
}
