import { EmitterWebhookEvent } from "@octokit/webhooks";
import { Handlers } from "./webhooks";

export const handlers: Handlers = {
  "issue_comment.created": async function issueCommentCreated(
    issueCommentCreatedPayload: EmitterWebhookEvent<"issue_comment.created">["payload"]
  ) {
    console.log(issueCommentCreatedPayload.comment.body);
  },
};
