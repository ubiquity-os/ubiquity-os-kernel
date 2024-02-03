import { GitHubEventHandler } from "../github-event-handler";
import { issueCommentCreated } from "./issue-comment/created";

export function bindHandlers(webhooks: GitHubEventHandler) {
  webhooks.on("issue_comment.created", issueCommentCreated);
}
