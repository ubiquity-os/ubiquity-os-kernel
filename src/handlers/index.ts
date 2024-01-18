import { EventHandler } from "../event-handler";
import { handleIssueCommentCreated } from "./issue/comment_created";

export function bindHandlers(webhooks: EventHandler) {
  webhooks.on("issue_comment.created", handleIssueCommentCreated);
}
