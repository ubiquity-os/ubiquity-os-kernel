// import { EmitterWebhookEvent } from "@octokit/webhooks";
// import { GitHubEventClassName } from "./types/github-event-class-names";

// export type Handlers = {
//   [K in GitHubEventClassName]?: (_payload: EmitterWebhookEvent<K>["payload"]) => Promise<void>;
// };

// export const handlers: Handlers = {
//   "issue_comment.created": async function issueCommentCreated(
//     issueCommentCreatedPayload: EmitterWebhookEvent<"issue_comment.created">["payload"]
//   ) {
//     console.log(issueCommentCreatedPayload.comment.body);
//   },
// };
import { EventHandler } from "../event-handler";
import { handleIssueCommentCreated } from "./issue/comment_created";

export function bindHandlers(webhooks: EventHandler) {
  webhooks.on("issue_comment.created", handleIssueCommentCreated);
}
