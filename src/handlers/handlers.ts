import { IssueCommentCreatedEvent } from "@octokit/webhooks-types";

export default {
  issueCommentCreated: async function issueCommentCreated(payload: IssueCommentCreatedEvent) {
    payload.comment.body = payload.comment.body.replace(/@/g, "!");
  },
};
