import { GitHubEventHandler } from "../github-event-handler";
import { handleIssueCommentCreated } from "./issue/comment_created";

export function bindHandlers(webhooks: GitHubEventHandler) {
  webhooks.on("issue_comment.created", handleIssueCommentCreated);
}
